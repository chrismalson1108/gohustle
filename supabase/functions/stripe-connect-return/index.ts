// Landing page after Stripe Connect onboarding completes.
// Stripe redirects here after the earner finishes (or exits) the Express onboarding flow.
Deno.serve((_req: Request) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GoHustlr — Payout Setup</title>
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
    <div class="icon">🎉</div>
    <h1>Payout Setup Complete!</h1>
    <p>Your bank account is connected. Return to the GoHustlr app — your earnings will be deposited automatically after jobs are verified.</p>
    <a href="#" class="back" onclick="window.close()">Return to App</a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
});
