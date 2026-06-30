// Backstop redirector. The Identity return page now lives on the web app
// (stripe-create-identity-session sets return_url to <web>/stripe/identity-return),
// because the Edge Functions gateway forces text/plain + nosniff on browser
// responses, so HTML served from here renders as raw source. This function remains
// only so that Stripe sessions created BEFORE that change (whose return_url still
// points here) land in the right place: a 302 redirects regardless of Content-Type.
const WEB_RETURN_URL = 'https://gohustlr.com/stripe/identity-return';

Deno.serve(() => {
  return new Response(null, {
    status: 302,
    headers: { Location: WEB_RETURN_URL, 'Cache-Control': 'no-store' },
  });
});
