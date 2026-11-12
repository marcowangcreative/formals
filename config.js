// Formals config. Both admin.html and wedding-shot-list.html load this file.
//
// This is the public anon key. It is safe to ship in the browser only because
// the database (see SETUP.md) does not let anon list, edit, or delete events.
// Never put the service_role key or the database password in this file.
window.FORMALS = {
  SUPABASE_URL: 'https://qhdzskmkijxfxxbsotkv.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoZHpza21raWp4Znh4YnNvdGt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NzEyMzIsImV4cCI6MjA5MjA0NzIzMn0.Rkua9orChlAIcv9zfDHfpitqWKshpP-fDKTElkkB8k4',
};
