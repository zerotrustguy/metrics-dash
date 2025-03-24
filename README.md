1. Upload a metrics file via the web interface.

2. The Worker parses the file, stores it in KV, and generates a dashboard with:
    - A human-readable summary (e.g., total requests, errors, latency).
    - A highlighted count of TCP sessions (likely source ports).
    - Interactive Chart.js visualizations for counters and histograms.

3. View the last two uploads via timestamped links.

