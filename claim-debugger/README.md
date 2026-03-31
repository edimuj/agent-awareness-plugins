# claim-debugger

An [agent-awareness](https://github.com/edimuj/agent-awareness) debug plugin for testing the multi-agent event claiming system.

MCP-tool-only — no triggers, no background activity. Invoke on demand to simulate events, inspect claims, and test contention scenarios.

## Installation

```bash
npm install -g agent-awareness-plugin-claim-debugger
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `awareness_claim_debugger_simulate` | Claim an event as this session — verify the claim path works |
| `awareness_claim_debugger_contend` | Create a fake foreign claim (PID 1) — test "being handled by another session" downgrade |
| `awareness_claim_debugger_release` | Release a claim (own or force-release foreign) |
| `awareness_claim_debugger_claims` | List all active claims with holder, TTL, and liveness status |
| `awareness_claim_debugger_clear` | Wipe all claims — nuclear reset for testing |

## Usage Examples

**Test that pr-pilot downgrades correctly:**
```
1. contend plugin:"pr-pilot" event:"vercel/next.js#4521:checks_failed"
2. Wait for pr-pilot's next interval gather
3. Verify output says "being handled by another session"
4. release plugin:"pr-pilot" event:"vercel/next.js#4521:checks_failed" force:true
```

**Inspect current claim state:**
```
claims                          → all active claims
claims plugin:"server-health"   → filtered to one plugin
claims all:true                 → include expired claims
```

**Simulate a server-health alert claim:**
```
simulate plugin:"server-health" event:"memory:escalated:critical" ttl:5
```

## Requirements

- agent-awareness v0.3.0+

## License

MIT
