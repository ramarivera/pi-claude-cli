# Correct Claude steering reporting and admission

Tracked by bead `pcc-6se` after Ramiro observed an unsolicited steering warning following a single hello in OMP.

OMP opens its live-steering channel for ordinary provider rounds, including empty queues. The adapter treated channel availability as a failed steering request and wrote a status warning. Remove that warning and report genuine failures through native assistant error events.

Both pinned Claude transports support `next` admission while host tools are parked. Support that path with a UUID-correlated native queue receipt before releasing original tool results. Preserve the resident turn, tool IDs and host ownership. OMP keeps queued messages until the host tool boundary; immediate during-token preemption isn't advertised.

Research the current Claude release and T3 Code before choosing protocol behavior. Cover empty queues, receipt ordering, shutdown and real Pi/OMP × CLI/SDK queued steering with automated tests and bounded authenticated runs.
