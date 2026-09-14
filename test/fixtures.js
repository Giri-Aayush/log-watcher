// Real lines captured from zebrad 6.2.0 (regtest, local) and 6.3.0 (testnet,
// Docker). Keep them verbatim: the parser is tested against what Zebra emits,
// not against what we wish it emitted.
const lines = {
  atTip: '2026-09-14T11:15:22.990083Z  INFO zebrad::components::sync::progress: finished initial sync to chain tip, using gossiped blocks sync_percent=100.000% current_height=Height(4345594) network_upgrade=Nu6_3 remaining_sync_blocks=0 time_since_last_state_block=0s',
  waiting: '2026-09-14T11:16:02.733823Z  INFO sync: zebrad::components::sync: waiting to restart sync timeout=67s state_tip=Some(Height(4345594))',
  inbound: '2026-09-14T11:15:00.230552Z  INFO {peer=In("v4redacted:42588")}:msg_as_req{msg="inv"}:inbound:download_and_verify{advertiser=Some(v4redacted:42588) hash=0000a6a8c81ab5193f4f997029101afb65feecfbbb781ea9e780c64244c3867e}: zebrad::components::inbound::downloads: ',
  committed: '2026-09-14T11:15:18.197350Z  INFO zebrad::components::sync::gossip: height=Height(4345594) request=AdvertiseBlock(block::Hash("00009739deaaad04500e21a619c16b00df13fa986cc2a91955a8e86e349b0082"), None) log_msg="sending committed block broadcast"',
  mined: '2026-09-14T11:19:50.602364Z  INFO zebrad::components::sync::gossip: height=Height(1) request=AdvertiseBlockToAll(block::Hash("aee6c7165c05b1f7cad6c68dde6973e93badcf244cd1e52fe62af62e348f9cf8")) log_msg="sending mined block broadcast"',
  submitted: '2026-09-14T11:19:50.602340Z  INFO rpc_request{otel.kind="server" rpc.method=generate rpc.system="jsonrpc"}: zebra_rpc::methods: submit block accepted hash=block::Hash("aee6c7165c05b1f7cad6c68dde6973e93badcf244cd1e52fe62af62e348f9cf8") height=Height(1)',
  banner: '2026-09-14T11:19:10.201004Z  INFO zebrad::application: Diagnostic metadata:',
  bannerVersion: 'version: 6.2.0',
  bannerNetwork: 'Zcash network: Regtest',
  regtestWarn: '2026-09-14T11:19:10.229346Z  WARN open_listener{addr=127.0.0.1:18344}: zebra_network::peer_set::initialize: We are configured with address 127.0.0.1:18344 on Regtest { activation_heights: {Height(0): Genesis, Height(1): Canopy}, funding_streams: [] }',
  verySlow: '2026-09-14T11:20:45.376166Z  INFO zebrad::components::sync::progress: initial sync is very slow, or estimated tip is wrong. Hint: check your network connection, and your computer clock and time zone sync_percent=0.000 % current_height=Some(Height(3)) network_upgrade=Canopy remaining_sync_blocks=6569283 after_checkpoint_height=None time_since_last_state_block=0s',
  eosTestnet: '2026-09-14T11:19:55.351346Z  INFO zebrad::components::sync::end_of_support: Release always valid in Testnet',
  eosUntil: '2026-09-14T11:19:55.351346Z  INFO zebrad::components::sync::end_of_support: Zebra release is supported until block 3200000, please report bugs at https://github.com/ZcashFoundation/zebra/issues',
  ansi: '\x1b[2m2026-09-14T11:16:02.733823Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mzebrad::components::sync\x1b[0m\x1b[2m:\x1b[0m waiting to restart sync \x1b[3mtimeout\x1b[0m\x1b[2m=\x1b[0m67s',
  error: '2026-09-14T11:40:00.000000Z ERROR zebra_state::service: block write task failed error=Disk full',
};

// Synthesise the "stalled" warning from progress.rs with realistic fields.
lines.stalled = '2026-09-14T11:45:00.000000Z  WARN zebrad::components::sync::progress: chain updates have stalled, state height has not increased for 12 minutes. Hint: check your network connection, and your computer clock and time zone sync_percent=100.000% current_height=Height(4345594) network_upgrade=Nu6_3 time_since_last_state_block=12m 3s target_block_spacing=75s max_block_spacing=8m 45s is_syncer_stopped=true';

// A committed-block line for any height, timestamped `at`.
function committedAt(height, at) {
  const ts = new Date(at).toISOString().replace('Z', '000Z');
  return `${ts}  INFO zebrad::components::sync::gossip: height=Height(${height}) request=AdvertiseBlock(block::Hash("${height.toString(16).padStart(64, '0')}"), None) log_msg="sending committed block broadcast"`;
}

module.exports = { lines, committedAt };
