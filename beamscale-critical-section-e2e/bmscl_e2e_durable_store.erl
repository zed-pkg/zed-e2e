-module(bmscl_e2e_durable_store).
-export([claim_owner/1]).

-define(TABLE, bmscl_e2e_owner_epochs).

claim_owner(Scope) when is_map(Scope) ->
    ensure_table(),
    Key = term_to_binary(Scope, [deterministic]),
    Epoch = ets:update_counter(?TABLE, Key, {2, 1}, {Key, 0}),
    {ok, Epoch};
claim_owner(_) ->
    {error, invalid_scope}.

ensure_table() ->
    case ets:whereis(?TABLE) of
        undefined ->
            try ets:new(?TABLE, [named_table, public, set, {write_concurrency, true}]) of
                _ -> ok
            catch
                error:badarg -> ok
            end;
        _ -> ok
    end.
