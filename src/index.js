addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === 'POST') {
    const formData = await request.formData();
    const metricsFile = formData.get('metricsFile');

    if (!metricsFile) {
      return new Response('No metrics file uploaded', { status: 400 });
    }

    const metricsData = await metricsFile.text();

    if (!isValidPrometheusMetrics(metricsData)) {
      return new Response('Invalid metrics file format. Please upload a valid Prometheus metrics file.', { status: 400 });
    }

    const timestamp = Date.now();
    const metrics = parsePrometheusMetrics(metricsData);

    const existingMetrics = await METRICS_STORAGE.list();
    const keys = existingMetrics.keys.map(k => k.name).sort().reverse();
    if (keys.length >= 2) {
      await METRICS_STORAGE.delete(keys[1]);
    }
    await METRICS_STORAGE.put(`metrics_${timestamp}`, JSON.stringify({ data: metricsData, timestamp }));

    const html = generateDashboard(metrics, timestamp);
    return new Response(html, {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }

  const url = new URL(request.url);
  const timestamp = url.searchParams.get('timestamp');
  if (timestamp) {
    const stored = await METRICS_STORAGE.get(`metrics_${timestamp}`);
    if (!stored) {
      return new Response('Metrics not found', { status: 404 });
    }
    const { data } = JSON.parse(stored);
    const metrics = parsePrometheusMetrics(data);
    return new Response(generateDashboard(metrics, timestamp), {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  }

  return new Response(await generateUploadForm(), {
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });
}

function parsePrometheusMetrics(data) {
  const metrics = { gauges: {}, counters: {}, histograms: {} }; 
  const lines = data.split('\n');

  for (const line of lines) {
    if (line.startsWith('#')) continue;

    const [nameLabels, value] = line.split(/\s+/);
    if (!nameLabels || !value) continue;

    const match = nameLabels.match(/([^[{]+)(?:{([^}]+)})?/);
    if (!match) continue;

    const [_, name, labelsStr] = match;
    const labels = labelsStr ? Object.fromEntries(labelsStr.split(',').map(l => l.split('=').map(s => s.replace(/"/g, '')))) : {};


    if (name.includes('_bucket')) {
      const baseName = name.replace('_bucket', '');
      if (!metrics.histograms[baseName]) metrics.histograms[baseName] = { buckets: [] };
      metrics.histograms[baseName].buckets.push({ le: labels.le, count: Number(value) });
    } else if (name.includes('_sum') || name.includes('_count')) {
      const baseName = name.replace(/_(sum|count)$/, '');
      if (!metrics.histograms[baseName]) metrics.histograms[baseName] = { buckets: [] };
      metrics.histograms[baseName][name.includes('_sum') ? 'sum' : 'count'] = Number(value);
    } else {
      metrics[name.includes('total') || name.includes('errors') ? 'counters' : 'gauges'][name] = {
        value: Number(value),
        labels,
      };
    }
  }
  return metrics;
}

function isValidPrometheusMetrics(data) {
  const lines = data.trim().split('\n');
  return lines.some(line => 
    line.startsWith('#') || 
    /^[a-zA-Z_:][a-zA-Z0-9_:]*({.*})?\s+-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(line.trim())
  );
}

function generateDashboard(metrics, timestamp) {
  const summary = generateSummary(metrics);
  const sourcePorts = metrics.counters['cloudflared_tcp_total_sessions']?.value || 0;
  
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Cloudflare Tunnel Metrics Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background-color: #f5f5f5; }
          .dashboard { max-width: 1000px; margin: 0 auto; background: #F5A623; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #333; }
          .section { margin: 20px 0; }
          .metric { padding: 10px; border-bottom: 1px solid #e59400; }
          .label { font-weight: bold; color: #333; }
          .value { color: #0066cc; margin-left: 10px; }
          canvas { max-width: 100%; background: white; padding: 10px; border-radius: 4px; }
          .summary { background: #fff3e0; padding: 15px; border-radius: 4px; }
          .highlight { background: #ffeb3b; padding: 2px 5px; border-radius: 3px; font-weight: bold; }
          .info-note { background: #ffe0b2; padding: 10px; border-radius: 4px; font-style: italic; }
        </style>
      </head>
      <body>
        <div class="dashboard">
          <h1>Cloudflare Tunnel Metrics Dashboard - ${new Date(Number(timestamp)).toLocaleString()}</h1>
          <p><a href="/" style="color: #0066cc;">Upload another metrics file</a></p>
          <div class="info-note">
            For a more advanced setup, you can integrate with Grafana following 
            <a href="https://developers.cloudflare.com/cloudflare-one/tutorials/grafana/" target="_blank">this guide</a>. 
            This dashboard offers a quick overview without the need to set up Grafana and Prometheus.
          </div>

          <div class="section">
            <h2>Summary</h2>
            <div class="summary">${summary}</div>
          </div>

          <div class="section">
            <h2>Key Metric: Source Ports Used</h2>
            <div class="metric">
              <span class="label">Total TCP Sessions (Source Ports)</span>
              <span class="value highlight">${sourcePorts.toLocaleString()}</span>
            </div>
          </div>

          <div class="section">
            <h2>Gauges</h2>
            ${Object.entries(metrics.gauges).map(([key, { value, labels }]) => `
              <div class="metric">
                <span class="label">${formatLabel(key)}</span>
                <span class="value">${formatValue(key, value)}</span>
                ${Object.keys(labels).length ? ` (${formatLabels(labels)})` : ''}
              </div>
            `).join('')}
          </div>

          <div class="section">
            <h2>Counters</h2>
            <canvas id="countersChart"></canvas>
            <script>
              const countersCtx = document.getElementById('countersChart').getContext('2d');
              new Chart(countersCtx, {
                type: 'bar',
                data: {
                  labels: [${Object.keys(metrics.counters).map(key => `'${formatLabel(key)}${Object.keys(metrics.counters[key].labels).length ? ` (${formatLabels(metrics.counters[key].labels)})` : ''}'`).join(',')}],
                  datasets: [{
                    label: 'Count',
                    data: [${Object.values(metrics.counters).map(m => m.value).join(',')}],
                    backgroundColor: '#0066cc',
                  }]
                },
                options: { scales: { y: { beginAtZero: true } } }
              });
            </script>
          </div>

          <div class="section">
            <h2>Histograms</h2>
            ${Object.entries(metrics.histograms).map(([key, { buckets, sum, count }]) => `
              <div class="metric">
                <span class="label">${formatLabel(key)}</span>
                <div>Avg: ${count ? (sum / count).toFixed(2) : 0} ms, Count: ${count || 0}</div>
                <canvas id="histogram_${key}"></canvas>
                <script>
                  const ctx_${key} = document.getElementById('histogram_${key}').getContext('2d');
                  new Chart(ctx_${key}, {
                    type: 'bar',
                    data: {
                      labels: [${buckets.map(b => `'≤${b.le}'`).join(',')}],
                      datasets: [{
                        label: 'Count',
                        data: [${buckets.map(b => b.count).join(',')}],
                        backgroundColor: '#0066cc',
                      }]
                    },
                    options: { scales: { y: { beginAtZero: true } } }
                  });
                </script>
              </div>
            `).join('')}
          </div>
        </div>
      </body>
    </html>
  `;
}

async function generateUploadForm() {
  const existingMetrics = await METRICS_STORAGE.list();
  const metricsList = await Promise.all(
    existingMetrics.keys.map(async k => {
      const stored = await METRICS_STORAGE.get(k.name);
      const { timestamp } = JSON.parse(stored);
      return { key: k.name, timestamp };
    })
  );
  const sortedMetrics = metricsList.sort((a, b) => b.timestamp - a.timestamp).slice(0, 2);

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Cloudflare Tunnel Metrics Dashboard - Upload</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: #F5A623; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #333; }
          input[type="file"] { margin: 10px 0; }
          input[type="submit"] { background: #0066cc; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
          input[type="submit"]:hover { background: #0055aa; }
          .history { margin-top: 20px; }
          .history-item { padding: 5px 0; }
          .info-note { background: #ffe0b2; padding: 10px; border-radius: 4px; font-style: italic; margin-top: 20px; }
          a { color: #0066cc; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Cloudflare Tunnel Metrics Dashboard</h1>
          <form method="POST" enctype="multipart/form-data">
            <label for="metricsFile">Upload Metrics File:</label><br>
            <input type="file" id="metricsFile" name="metricsFile" accept=".txt,.prom" required><br>
            <input type="submit" value="Upload and View Dashboard">
          </form>
          <div class="history">
            <h2>Recent Uploads (Last 2)</h2>
            ${sortedMetrics.length ? sortedMetrics.map(m => `
              <div class="history-item">
                <a href="/?timestamp=${m.timestamp}">${new Date(m.timestamp).toLocaleString()}</a>
              </div>
            `).join('') : '<p>No metrics uploaded yet.</p>'}
          </div>
          <div class="info-note">
            <p><strong>How to fetch your metrics file:</strong></p>
            <ul>
              <li>Search for "metrics" in your Cloudflare tunnel logs to find the endpoint (e.g., <code>curl 127.0.0.1:20241/metrics</code>).</li>
              <li>Check the tunnel startup logs—metrics endpoint details are typically shown when <code>cloudflared</code> starts.</li>
              <li>If your tunnel was created via the dashboard, add the <code>--metrics</code> flag to your <code>cloudflared</code> system service configuration. 
                Refer to <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/#update-tunnel-run-parameters" target="_blank">these instructions</a> for details.</li>
            </ul>
          </div>
        </div>
      </body>
    </html>
  `;
}

function generateSummary(metrics) {
  const totalRequests = metrics.counters['cloudflared_tunnel_total_requests']?.value || 0;
  const requestErrors = metrics.counters['cloudflared_tunnel_request_errors']?.value || 0;
  const haConnections = metrics.gauges['cloudflared_tunnel_ha_connections']?.value || 0;
  const latency = metrics.histograms['cloudflared_proxy_connect_latency']?.sum / metrics.histograms['cloudflared_proxy_connect_latency']?.count || 0;
  const sourcePorts = metrics.counters['cloudflared_tcp_total_sessions']?.value || 0;

  return `
    <p>This system has handled <strong>${totalRequests.toLocaleString()}</strong> total requests through its tunnels, 
    with <strong>${requestErrors.toLocaleString()}</strong> errors encountered. 
    It’s currently maintaining <strong>${haConnections}</strong> active high-availability connections. 
    The average connection latency is <strong>${latency.toFixed(2)} ms</strong>, and it has used 
    <strong class="highlight">${sourcePorts.toLocaleString()}</strong> TCP sessions (likely source ports).</p>
  `;
}

function formatLabel(key) {
  return key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function formatValue(key, value) {
  if (key.includes('bytes')) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (key.includes('latency')) return `${value} ms`;
  return value.toLocaleString();
}

function formatLabels(labels) {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(', ');
}