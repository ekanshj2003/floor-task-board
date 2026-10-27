// ─────────────────────────────────────────────────────────────
//  Fill these in after setting up Supabase (see README, step 7).
//  These values are safe to publish: the anon key and the VAPID
//  PUBLIC key are meant to be public. Never put the service role
//  key or the VAPID PRIVATE key here.
// ─────────────────────────────────────────────────────────────
window.APP_CONFIG = {
  // Supabase → Settings → API → Project URL
  SUPABASE_URL: "https://ibgmbggojngmvwddboda.supabase.co",

  // Supabase → Settings → API → anon public key
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImliZ21iZ2dvam5nbXZ3ZGRib2RhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwODY4MjMsImV4cCI6MjEwODY2MjgyM30.hoMGFzZhXnMe9VpcVXokWsOzy4K4NZCH5j3KJOdXu7Y",

  // From docs/keys.html → "Public key"
  VAPID_PUBLIC_KEY: "BGuqa3HWhveLLf8C3qj775bhzs0HwIgjeF4QNfbGwRGQdIA8GUenXbSHwPxfCP2zLrcXvEj7uHnehh0JOmRMo2o",

  // Shown in the app header
  COMPANY_NAME: "Floor Task Board",

  // Turn on only after setting up an SMS provider in Supabase (README, optional step)
  ENABLE_MOBILE_OTP: false,
};
