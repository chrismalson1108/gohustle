// Landing page after the Stripe Identity flow completes.
// Stripe redirects here when the user finishes (or exits) document verification.
// The actual verification result arrives asynchronously via the webhook, so this
// page just reassures the user and sends them back to the app.
Deno.serve((_req: Request) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GoHustlr — Identity Verification</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f3ff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      padding: 40px 32px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(109,40,217,0.12);
    }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { color: #6D28D9; font-size: 22px; margin-bottom: 10px; }
    p  { color: #6B7280; font-size: 15px; line-height: 1.5; }
    .back {
      display: inline-block;
      margin-top: 28px;
      background: #6D28D9;
      color: #fff;
      padding: 12px 28px;
      border-radius: 12px;
      font-weight: 700;
      text-decoration: none;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🪪</div>
    <h1>Thanks — We're Reviewing Your ID</h1>
    <p>Your documents were submitted. Verification usually completes within a few minutes. Head back to GoHustlr — your Verified badge will appear once it's confirmed.</p>
    <a href="#" class="back" onclick="window.close()">Return to App</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});
