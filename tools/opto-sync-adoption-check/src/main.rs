use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use toml::Value as TomlValue;

const REQUIRED_SCENARIOS: &[&str] = &[
    "frozen-install-provenance",
    "offline-restart",
    "optimistic-local-view-rebase",
    "remote-confirmed-write",
    "idempotent-replay",
    "conflict-and-tombstone",
    "indexeddb",
    "sqlite",
    "postgres-supabase",
    "background-handoff",
];

fn target_manifest(language: &str) -> Option<&'static str> {
    match language {
        "rust" => Some("Cargo.toml"),
        "typescript" => Some("package.json"),
        "dart" => Some("pubspec.yaml"),
        "gleam" => Some("gleam.toml"),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    schema_version: u64,
    rollout_issue: String,
    parent_issue: String,
    release_gates: Vec<String>,
    wrapper_repository: String,
    wrapper_ref: String,
    e2e_repository: String,
    dependency: Dependency,
    native_adapters: BTreeMap<String, String>,
    required_scenarios: Vec<String>,
    #[serde(default)]
    legacy_parity_required: bool,
    #[serde(default)]
    legacy_source_pins: BTreeMap<String, String>,
    #[serde(default)]
    bootstrap_independent: bool,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    package: String,
    range: String,
    install_root: String,
}

fn is_safe_relative(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !value.contains('\\')
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn load_json(path: &Path) -> Result<JsonValue, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|error| format!("invalid JSON object {}: {error}", path.display()))
}

fn load_toml(path: &Path) -> Result<TomlValue, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    toml::from_str(&source).map_err(|error| format!("invalid TOML {}: {error}", path.display()))
}

fn load_profile(path: &Path) -> Result<Profile, String> {
    let source = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|error| format!("invalid adoption profile {}: {error}", path.display()))
}

fn validate_profile(profile: &Profile) -> Vec<String> {
    let mut errors = Vec::new();
    if profile.schema_version != 1 {
        errors.push("schemaVersion must equal 1".to_owned());
    }
    if profile.rollout_issue != "DEN-1386" {
        errors.push("rolloutIssue must equal DEN-1386".to_owned());
    }
    if profile.parent_issue != "DEN-313" {
        errors.push("parentIssue must equal DEN-313".to_owned());
    }
    let release_gates: BTreeSet<&str> = profile.release_gates.iter().map(String::as_str).collect();
    if release_gates != BTreeSet::from(["DEN-309", "DEN-363"]) {
        errors.push("releaseGates must contain exactly DEN-309 and DEN-363".to_owned());
    }
    if profile.dependency
        != (Dependency {
            package: "opto-sync/opto-sync-clients".to_owned(),
            range: "^0.2.0".to_owned(),
            install_root: "zed_modules/opto-sync/opto-sync-clients".to_owned(),
        })
    {
        errors.push("dependency must match the certified Opto-Sync package contract".to_owned());
    }
    if profile.wrapper_repository.trim().is_empty() || profile.wrapper_ref.trim().is_empty() {
        errors.push("wrapperRepository and wrapperRef must be non-empty".to_owned());
    }
    if profile.e2e_repository != "zed-pkg/zed-e2e" {
        errors.push("e2eRepository must equal zed-pkg/zed-e2e".to_owned());
    }

    let scenarios: BTreeSet<&str> = profile
        .required_scenarios
        .iter()
        .map(String::as_str)
        .collect();
    for scenario in REQUIRED_SCENARIOS {
        if !scenarios.contains(scenario) {
            errors.push(format!("missing required scenario: {scenario}"));
        }
    }
    if profile.native_adapters.is_empty() {
        errors.push("nativeAdapters must not be empty".to_owned());
    }
    let install_prefix = format!("{}/", profile.dependency.install_root);
    for (language, relative) in &profile.native_adapters {
        if target_manifest(language).is_none() {
            errors.push(format!("unsupported native adapter language: {language}"));
        }
        if !is_safe_relative(relative) {
            errors.push(format!("native adapter path is not safe and relative: {relative}"));
        }
        if !relative.starts_with(&install_prefix) {
            errors.push(format!(
                "native adapter path must be beneath {}: {relative}",
                profile.dependency.install_root
            ));
        }
    }
    if profile.legacy_parity_required && profile.legacy_source_pins.is_empty() {
        errors.push("legacy parity requires exact source-pin paths".to_owned());
    }
    for (label, relative) in &profile.legacy_source_pins {
        if !is_safe_relative(relative) {
            errors.push(format!("legacy source pin {label} is not a safe relative path"));
        }
    }
    errors
}

fn toml_string<'a>(value: &'a TomlValue, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn validate_wrapper(profile: &Profile, wrapper: &Path, live: bool) -> Vec<String> {
    let mut errors = Vec::new();
    let manifest = match load_toml(&wrapper.join(".zpkg.toml")) {
        Ok(value) => value,
        Err(error) => {
            errors.push(error);
            return errors;
        }
    };
    let lock = match load_toml(&wrapper.join(".zpkg.lock")) {
        Ok(value) => value,
        Err(error) => {
            errors.push(error);
            return errors;
        }
    };
    let adapter = match load_json(&wrapper.join("opto-sync-adapter.json")) {
        Ok(value) if value.is_object() => value,
        Ok(_) => {
            errors.push("opto-sync-adapter.json must contain a JSON object".to_owned());
            return errors;
        }
        Err(error) => {
            errors.push(error);
            return errors;
        }
    };

    if toml_string(
        &manifest,
        &["dependencies", "opto-sync/opto-sync-clients"],
    ) != Some("^0.2.0")
    {
        errors.push("wrapper dependency must pin opto-sync-clients to ^0.2.0".to_owned());
    }
    if toml_string(&manifest, &["install", "dir"]) != Some("zed_modules") {
        errors.push("wrapper install.dir must equal zed_modules".to_owned());
    }
    if adapter.get("repository").and_then(JsonValue::as_str)
        != Some(profile.wrapper_repository.as_str())
    {
        errors.push("adapter repository does not match the adoption profile".to_owned());
    }
    if adapter.get("e2eRepository").and_then(JsonValue::as_str)
        != Some(profile.e2e_repository.as_str())
    {
        errors.push("adapter e2eRepository does not match the adoption profile".to_owned());
    }
    if adapter.get("dependency") != serde_json::to_value(&profile.dependency).ok().as_ref() {
        errors.push("adapter dependency does not match the adoption profile".to_owned());
    }

    let packages: &[TomlValue] = lock
        .get("package")
        .and_then(TomlValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !live {
        if adapter.get("releaseState").and_then(JsonValue::as_str)
            == Some("blocked-until-certified-package-published")
            && (lock.get("version").and_then(TomlValue::as_integer) != Some(1)
                || !packages.is_empty())
        {
            errors.push(
                "blocked release state requires lock version 1 with no resolved packages"
                    .to_owned(),
            );
        }
        return errors;
    }

    let package = packages.iter().find(|item| {
        item.get("org").and_then(TomlValue::as_str) == Some("opto-sync")
            && item.get("name").and_then(TomlValue::as_str) == Some("opto-sync-clients")
    });
    let Some(package) = package else {
        errors.push("live lock is missing opto-sync/opto-sync-clients".to_owned());
        return errors;
    };
    let sha256 = package.get("sha256").and_then(TomlValue::as_str).unwrap_or("");
    if !is_hex(sha256, 64) {
        errors.push("live package sha256 must be 64 hexadecimal characters".to_owned());
    }
    if package.get("size").and_then(TomlValue::as_integer).unwrap_or(0) <= 0 {
        errors.push("live package size must be positive".to_owned());
    }
    for field in ["format", "vcs_tag", "source"] {
        if package
            .get(field)
            .and_then(TomlValue::as_str)
            .is_none_or(str::is_empty)
        {
            errors.push(format!("live package {field} must be non-empty"));
        }
    }
    let commit = package
        .get("vcs_commit")
        .and_then(TomlValue::as_str)
        .unwrap_or("");
    if !is_hex(commit, 40) {
        errors.push("live package vcs_commit must be a full hexadecimal SHA".to_owned());
    }

    for (language, relative) in &profile.native_adapters {
        let Some(manifest_name) = target_manifest(language) else {
            continue;
        };
        let target = wrapper.join(relative).join(manifest_name);
        if !target.is_file() {
            errors.push(format!(
                "missing installed {language} adapter: {}",
                target.display()
            ));
        }
    }
    if profile.legacy_parity_required {
        for (label, relative) in &profile.legacy_source_pins {
            let target = wrapper.join(relative);
            if !target.exists() {
                errors.push(format!(
                    "missing legacy parity source {label}: {}",
                    target.display()
                ));
            }
        }
    }
    errors
}

fn dependency_names(manifest_path: &Path) -> Result<BTreeSet<String>, String> {
    let manifest = load_toml(manifest_path)?;
    let mut names = BTreeSet::new();
    for section in ["dependencies", "build-dependencies", "dev-dependencies"] {
        if let Some(table) = manifest.get(section).and_then(TomlValue::as_table) {
            names.extend(table.keys().cloned());
        }
    }
    Ok(names)
}

fn validate_bootstrap(
    profile: &Profile,
    zed_cli: Option<&Path>,
    zed_interfaces: Option<&Path>,
) -> Vec<String> {
    let mut errors = Vec::new();
    if !profile.bootstrap_independent {
        return errors;
    }
    match (zed_cli, zed_interfaces) {
        (None, None) => return errors,
        (Some(_), None) | (None, Some(_)) => {
            errors.push(
                "bootstrap independence requires both zed-cli and zed-interfaces source trees"
                    .to_owned(),
            );
            return errors;
        }
        (Some(cli), Some(interfaces)) => {
            for manifest_path in [cli.join("Cargo.toml"), interfaces.join("Cargo.toml")] {
                match dependency_names(&manifest_path) {
                    Ok(names) => {
                        let forbidden: Vec<String> = names
                            .into_iter()
                            .filter(|name| {
                                name.to_ascii_lowercase().contains("opto") || name == "zed-sync"
                            })
                            .collect();
                        if !forbidden.is_empty() {
                            errors.push(format!(
                                "{} has forbidden bootstrap dependencies: {forbidden:?}",
                                manifest_path.display()
                            ));
                        }
                    }
                    Err(error) => errors.push(error),
                }
            }
        }
    }
    errors
}

#[derive(Default)]
struct Args {
    profile: PathBuf,
    wrapper: Option<PathBuf>,
    live: bool,
    zed_cli: Option<PathBuf>,
    zed_interfaces: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut parsed = Args {
        profile: PathBuf::from("opto-sync-adoption.json"),
        ..Args::default()
    };
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--profile" => {
                parsed.profile = PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--profile requires a path".to_owned())?,
                );
            }
            "--wrapper" => {
                parsed.wrapper = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--wrapper requires a path".to_owned())?,
                ));
            }
            "--live" => parsed.live = true,
            "--zed-cli" => {
                parsed.zed_cli = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--zed-cli requires a path".to_owned())?,
                ));
            }
            "--zed-interfaces" => {
                parsed.zed_interfaces = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--zed-interfaces requires a path".to_owned())?,
                ));
            }
            "-h" | "--help" => {
                println!(
                    "Usage: zed-opto-sync-adoption-check [--profile PATH] [--wrapper PATH] [--live] [--zed-cli PATH] [--zed-interfaces PATH]"
                );
                return Err(String::new());
            }
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) if message.is_empty() => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let profile = match load_profile(&args.profile) {
        Ok(profile) => profile,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    let mut errors = validate_profile(&profile);
    if let Some(wrapper) = args.wrapper.as_deref() {
        errors.extend(validate_wrapper(&profile, wrapper, args.live));
    } else if args.live {
        errors.push("--live requires --wrapper".to_owned());
    }
    errors.extend(validate_bootstrap(
        &profile,
        args.zed_cli.as_deref(),
        args.zed_interfaces.as_deref(),
    ));

    if errors.is_empty() {
        println!(
            "validated Opto-Sync adoption contract for {}",
            profile.e2e_repository
        );
        ExitCode::SUCCESS
    } else {
        eprintln!("Opto-Sync adoption contract validation failed:");
        for error in errors {
            eprintln!(" - {error}");
        }
        ExitCode::from(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository_profile() -> Profile {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        load_profile(&root.join("opto-sync-adoption.json")).expect("repository profile")
    }

    #[test]
    fn repository_profile_passes() {
        assert_eq!(validate_profile(&repository_profile()), Vec::<String>::new());
    }

    #[test]
    fn invalid_values_are_explicit_errors_in_every_build_mode() {
        let mut profile = repository_profile();
        profile.schema_version = 999;
        profile.release_gates.clear();
        profile.dependency.range = "*".to_owned();
        let errors = validate_profile(&profile);
        assert!(errors.iter().any(|error| error.contains("schemaVersion")));
        assert!(errors.iter().any(|error| error.contains("releaseGates")));
        assert!(errors.iter().any(|error| error.contains("dependency")));
    }

    #[test]
    fn adapter_path_traversal_is_rejected() {
        let mut profile = repository_profile();
        profile.native_adapters.insert(
            "rust".to_owned(),
            "zed_modules/opto-sync/opto-sync-clients/../../outside".to_owned(),
        );
        let errors = validate_profile(&profile);
        assert!(errors.iter().any(|error| error.contains("not safe and relative")));
    }

    #[test]
    fn partial_bootstrap_sources_are_rejected_before_file_access() {
        let profile = repository_profile();
        let errors = validate_bootstrap(&profile, Some(Path::new("missing-cli")), None);
        assert!(errors
            .iter()
            .any(|error| error.contains("requires both zed-cli and zed-interfaces")));
    }
}
