// ============================================================
// config.js — MindSpace Supabase Configuration
// ============================================================
// SETUP INSTRUCTIONS:
// 1. Go to https://supabase.com and create a free project
// 2. Go to Project Settings → API
// 3. Copy your Project URL and anon/public key below
// 4. Run the SQL in database.sql in your Supabase SQL editor
// ============================================================

const SUPABASE_URL = 'https://ltwmlgmipvjfboagwyct.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0d21sZ21pcHZqZmJvYWd3eWN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzODE1NzgsImV4cCI6MjA5NDk1NzU3OH0.0kcj6mGPoweVblmjYxPUs_KKRZUvn_cdyO9qjgF2J4o';

// Admin email — this user gets counsellor/admin privileges
// After signing up with this email, they see the admin dashboard
const ADMIN_EMAIL = 'admin@mindspace.com';

// Initialize Supabase client
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } }
});

window.sb = sb;
window.ADMIN_EMAIL = ADMIN_EMAIL;