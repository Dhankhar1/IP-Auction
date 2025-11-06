# Live Auction Bidding

A real-time auction platform for 6 registered teams (each: 1 main bidder/moderator + 2 support members) to bid on players. Admin controls auction flow (start/pause/next player), sets player-registration window, allocates initial tokens (e.g., IP Token: 1000), and monitors live updates. Audience gets a live view of the auction.

Key requirements:
- Team registration/login, role-based access (admin, main bidder, support, audience)
- Player registration portal with admin-set open/close window
- Live, low-latency updates for admin/team/audience views (bids, budgets, sold-to, history)
- Post-sale recording: which team bought which player, price, remaining tokens
- Team panel becomes bidding panel once auction starts; see purchase history and current bid

Priority: real-time, reliable, auto-updating data with minimal delay.
