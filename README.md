# pi-chains

Chains for pi: one model per role that falls back through an ordered list of models when an account runs out of usage.

The Chains file is `<agent dir>/chains.json`, where the agent dir is `PI_CODING_AGENT_DIR` when set and `~/.pi/agent` otherwise. The used-up account marks are kept in `${XDG_STATE_HOME:-~/.local/state}/pi-chains/accounts.json`, one file for every pi session on the Mac whatever its agent dir.

Moved out of the Factory (github.com/bradley-mankoff/factory) at its commit 9aaed8d on 2026-11-08, because pi extensions and herdr plugins are tools of the Human's own setup rather than parts of the Factory (Factory Bead fac-qpv.8). The Factory installs it as a dependency.

Install: `pi install git:github.com/bradley-mankoff/pi-chains`
