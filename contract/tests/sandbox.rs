//! Integration test: the compiled contract on a local NEAR Sandbox node.
//!
//! Covers the full loop on real WebAssembly: claim → volunteer → a second
//! volunteer is refused → an unsaved round pays It → transfer → poke.
//! Rounds are advanced with the sandbox's block fast-forward.

use near_api::{AccountId, NearToken};
use near_sdk::serde_json::{Value, json};

const NOTIT: u128 = 1_000_000_000_000_000_000;
const CLAIM: u128 = 1_000 * NOTIT;
const ROUND_NS: u64 = 120_000_000_000;

type Net = near_api::NetworkConfig;

async fn create_subaccount(
    sandbox: &near_sandbox::Sandbox,
    name: &str,
) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox
        .create_account(account_id.clone().as_str().parse()?)
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}

async fn view(
    contract: &near_api::Contract,
    net: &Net,
    method: &str,
    args: Value,
) -> testresult::TestResult<Value> {
    Ok(contract
        .call_function(method, args)
        .read_only()
        .fetch_from(net)
        .await?
        .data)
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().expect("decimal string").parse().expect("u128")
}

async fn balance(
    contract: &near_api::Contract,
    net: &Net,
    who: &near_api::Account,
) -> testresult::TestResult<u128> {
    Ok(u128_of(
        &view(
            contract,
            net,
            "ft_balance_of",
            json!({ "account_id": who.account_id() }),
        )
        .await?,
    ))
}

/// Fast-forward blocks until the contract reports a round ≥ `round`.
async fn advance_to_round(
    sandbox: &near_sandbox::Sandbox,
    contract: &near_api::Contract,
    net: &Net,
    round: u64,
) -> testresult::TestResult<Value> {
    for _ in 0..200 {
        let state = view(contract, net, "get_state", json!({})).await?;
        if state["round"].as_u64().unwrap() >= round {
            return Ok(state);
        }
        sandbox.fast_forward(50).await?;
    }
    panic!("the sandbox clock did not reach round {round}");
}

#[tokio::test]
async fn full_game_loop_on_sandbox() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .unwrap(),
    )?;

    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let carol = create_subaccount(&sandbox, "carol.sandbox").await?;
    let contract = create_subaccount(&sandbox, "notit.sandbox")
        .await?
        .as_contract();

    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call(
            "new",
            json!({ "params": {
                "round_ns": ROUND_NS.to_string(),
                "max_cost_ppm": 50_000,
                "min_cost_ppm": 2_000,
                "cut_ppm": 150_000,
                "claim_amount": CLAIM.to_string(),
                "claim_cap": 100_000,
            }}),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    // Standard metadata and the immutable configuration are readable by anyone.
    let meta = view(&contract, &net, "ft_metadata", json!({})).await?;
    assert_eq!(meta["symbol"], "NOTIT");
    assert_eq!(meta["decimals"], 18);
    let config = view(&contract, &net, "get_config", json!({})).await?;
    assert_eq!(config["cut_ppm"], 150_000);
    assert_eq!(config["max_collapse_run"], 8);

    // Each holder claims once; the storage fee is attached and the excess refunded.
    for who in [&alice, &bob, &carol] {
        contract
            .call_function("claim", ())
            .transaction()
            .deposit(NearToken::from_millinear(10))
            .with_signer(who.account_id().clone(), signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        assert_eq!(balance(&contract, &net, who).await?, CLAIM);
    }
    // A second claim is refused.
    contract
        .call_function("claim", ())
        .transaction()
        .deposit(NearToken::from_millinear(10))
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // Move to a round that opened with all three claims in its supply snapshot.
    let claimed_in = view(&contract, &net, "get_state", json!({})).await?["round"]
        .as_u64()
        .unwrap();
    let state = advance_to_round(&sandbox, &contract, &net, claimed_in + 1).await?;
    assert_eq!(u128_of(&state["round_supply"]), 3 * CLAIM);
    assert!(state["it"].is_null(), "nobody has volunteered yet");
    assert_eq!(state["armed"], false);

    // alice volunteers with both guards: the round she sees and the cost she sees.
    let round = state["round"].as_u64().unwrap();
    contract
        .call_function(
            "volunteer",
            json!({ "round": round, "max_cost": state["cost_now"] }),
        )
        .transaction()
        .with_signer(alice.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let state = view(&contract, &net, "get_state", json!({})).await?;
    assert_eq!(state["saved"], true);
    assert_eq!(state["it"], alice.account_id().to_string());
    let cost = u128_of(&state["stats"]["total_burned"]);
    assert!((3 * CLAIM * 2_000 / 1_000_000..=3 * CLAIM * 50_000 / 1_000_000).contains(&cost));
    assert_eq!(balance(&contract, &net, &alice).await?, CLAIM - cost);

    // Only the first volunteer in a round succeeds.
    contract
        .call_function("volunteer", json!({}))
        .transaction()
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();
    assert_eq!(
        balance(&contract, &net, &bob).await?,
        CLAIM,
        "a refused volunteer costs nothing"
    );

    // Let at least one round end with no volunteer: everyone is cut 15 % and It collects.
    let state = advance_to_round(&sandbox, &contract, &net, round + 2).await?;
    let collapsed = state["stats"]["rounds_collapsed"].as_u64().unwrap();
    assert!((1..=8).contains(&collapsed), "collapsed = {collapsed}");
    let mut expected_bob = CLAIM;
    for _ in 0..collapsed {
        expected_bob = expected_bob * 85 / 100;
    }
    let bob_balance = balance(&contract, &net, &bob).await?;
    assert!(
        bob_balance.abs_diff(expected_bob) <= collapsed as u128,
        "bob = {bob_balance}"
    );
    let alice_view = view(
        &contract,
        &net,
        "get_account",
        json!({ "account_id": alice.account_id() }),
    )
    .await?;
    assert_eq!(alice_view["is_it"], true);
    assert!(u128_of(&alice_view["collected"]) > 0);
    assert!(
        u128_of(&alice_view["balance"]) > CLAIM - cost,
        "It ends up ahead"
    );
    // A collapse moves value from everyone to It; the total does not change.
    let supply = u128_of(&view(&contract, &net, "ft_total_supply", json!({})).await?);
    assert!(
        supply.abs_diff(3 * CLAIM - cost) <= 2 * collapsed as u128,
        "supply = {supply}"
    );

    // Views were computed virtually. Poke writes the same state.
    contract
        .call_function("poke", ())
        .transaction()
        .with_signer(carol.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let history = view(
        &contract,
        &net,
        "get_history",
        json!({ "from_index": 0, "limit": 10 }),
    )
    .await?;
    assert_eq!(history[0]["kind"], "saved");
    assert_eq!(history[0]["hero"], alice.account_id().to_string());
    assert_eq!(history[1]["kind"], "collapsed");
    assert_eq!(history[1]["it"], alice.account_id().to_string());

    // NEP-141 transfer with the mandatory 1 yoctoNEAR.
    let carol_before = balance(&contract, &net, &carol).await?;
    contract
        .call_function(
            "ft_transfer",
            json!({ "receiver_id": carol.account_id(), "amount": (100 * NOTIT).to_string() }),
        )
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let carol_after = balance(&contract, &net, &carol).await?;
    assert!(
        carol_after >= carol_before + 100 * NOTIT || carol_after < carol_before,
        "transfer arrived or a collapse intervened"
    );

    // Without the deposit the transfer is refused.
    contract
        .call_function(
            "ft_transfer",
            json!({ "receiver_id": carol.account_id(), "amount": NOTIT.to_string() }),
        )
        .transaction()
        .with_signer(bob.account_id().clone(), signer.clone())
        .send_to(&net)
        .await?
        .assert_failure();

    Ok(())
}
