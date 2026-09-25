#!/usr/bin/env python3
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
anchor = "async fn critical_section("
start = text.index(anchor)
needle = '        if backend == "mock" {'
pos = text.index(needle, start)
replacement = '''        if backend == "mock" && env::var_os("BMSCL_MOCK_GUEST_CONTROL_ADDR").is_some() {
            let addr = env::var("BMSCL_MOCK_GUEST_CONTROL_ADDR")
                .map_err(|err| api_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
            invoke_over_tcp(
                &addr,
                &request_bytes,
                req.timeout_ms,
                state.guest_max_frame_bytes,
            )
            .await
            .map_err(|message| api_error(StatusCode::SERVICE_UNAVAILABLE, message))
        } else if backend == "mock" {'''
text = text[:pos] + replacement + text[pos + len(needle):]

helper_anchor = "async fn invoke_over_vsock("
helper_pos = text.index(helper_anchor)
helper = r'''async fn invoke_over_tcp(
    addr: &str,
    request_bytes: &[u8],
    timeout_ms: u64,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, String> {
    use tokio::net::TcpStream;

    if request_bytes.len() > max_frame_bytes || request_bytes.len() > u32::MAX as usize {
        return Err("guest-control request frame too large".into());
    }
    let deadline = Duration::from_millis(timeout_ms);
    timeout(deadline, async {
        let mut stream = TcpStream::connect(addr)
            .await
            .map_err(|err| format!("connect mock guest control {addr}: {err}"))?;
        stream
            .write_all(&(request_bytes.len() as u32).to_be_bytes())
            .await
            .map_err(|err| format!("write mock guest-control frame length: {err}"))?;
        stream
            .write_all(request_bytes)
            .await
            .map_err(|err| format!("write mock guest-control frame: {err}"))?;
        stream
            .flush()
            .await
            .map_err(|err| format!("flush mock guest-control frame: {err}"))?;

        let mut len = [0u8; 4];
        stream
            .read_exact(&mut len)
            .await
            .map_err(|err| format!("read mock guest-control response length: {err}"))?;
        let response_len = u32::from_be_bytes(len) as usize;
        if response_len == 0 || response_len > max_frame_bytes {
            return Err(format!("mock guest-control response frame length invalid: {response_len}"));
        }
        let mut response = vec![0u8; response_len];
        stream
            .read_exact(&mut response)
            .await
            .map_err(|err| format!("read mock guest-control response: {err}"))?;
        Ok(response)
    })
    .await
    .map_err(|_| "mock guest-control request timed out".to_string())?
}

'''
text = text[:helper_pos] + helper + text[helper_pos:]
path.write_text(text)
