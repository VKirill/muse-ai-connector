STATUS: complete

# Pass timeoutMs on slow host calls so relogin no longer hits BB's 30 s deadline

server.ts calls host methods without timeoutMs, so BB cuts each call at its 30 s default; relogin/add (11 min), check (120 s), usage (45 s) and install fail with 'host plugin call … exceeded its deadline' and the sync to other machines never runs. Pass timeoutMs above each host-side limit.

Attempt 1 accepted by Lane Pilot BB writer.
