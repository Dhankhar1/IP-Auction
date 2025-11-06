# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Commands

Node.js app with Express + WebSocket.

Install deps:
- `npm install`

Run dev server (auto-reload):
- `npm run dev`

Run production server:
- `npm start`

Environment (optional):
- `ADMIN_PASS` (default: `adminpass`)
- `INITIAL_TOKENS` (default: `1000`)
- `PORT` (default: `3000`)

Git helpers (no pager):
- `git --no-pager status`
- `git --no-pager log --oneline -n 20`

## High-level architecture (planned per README)

Roles and access
- Admin: controls auction flow (start, pause, advance to next player), sets player registration window, allocates initial tokens, oversees live state.
- Teams (6 total): 1 main bidder/moderator + 2 support members; team panel becomes bidding panel once auction starts.
- Audience: live read-only view of bids, sold-to, budgets, and history.

Core domain entities
- Team: name, members, credentials, remaining token balance.
- Player: registration data; status (available/sold); sold_to and price after sale.
- Auction: current player, phase (idle/running/paused), bid increment rules, history of bids and sales.
- Bid: team_id, amount, timestamp, validity checks against remaining tokens.
- Token ledger: initial allocation (e.g., IP Token: 1000) and debits on purchase.

System components (target state)
- Realtime transport: WebSocket-based pub/sub for low-latency updates across admin, team, and audience UIs.
- AuthZ/AuthN (minimal to start): pre-shared team credentials; role-based permissions (admin, main bidder, support, audience/read-only).
- Admin service: controls auction lifecycle, opens/closes player registration window, advances players.
- Bidding service: validates bids (budget, increment, state), resolves winner, updates token ledger and player status.
- Read models/views: optimized feeds for UI panels (current bid, budgets, purchase history, sold-to).
- Persistence: durable storage of teams, players, auction state, bids, and history.

Operational behavior
- Live, low-latency propagation of: current player, leading bid, budgets, sold-to, and history.
- Post-sale recording: team, price, and remaining tokens are committed atomically with sale.

## Product intent from maintainer (for initial implementation)
- Teams access via pre-defined per-team credentials (e.g., TEAM1 / leopard) or team-specific links.
- Prefer minimal auth to start; enhancements can follow later.
- Use any WebSocket implementation to deliver an auto-updating live site.

## Source of truth
- Current repository files: `README.md` describes requirements; implementation code is not yet present. Update this WARP.md as code and tooling are introduced.
