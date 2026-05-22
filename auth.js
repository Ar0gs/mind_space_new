// ============================================================
// auth.js — MindSpace Authentication
// ============================================================

async function handleLogin() {
  const email = document.getElementById('login-email')?.value?.trim();
  const pass = document.getElementById('login-pass')?.value;
  const errEl = document.getElementById('login-err');

  if (!email || !pass) { errEl.textContent = '↳ Please fill in all fields.'; return; }

  errEl.textContent = 'Signing in...';

  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });

  if (error) {
    errEl.textContent = '↳ ' + (error.message || 'Sign in failed. Please try again.');
    return;
  }

  errEl.style.color = '#1900ff';
  errEl.textContent = '✓ Welcome back. Redirecting...';

  setTimeout(() => redirectUser(data.user), 800);
}

async function handleRegister() {
  const name = document.getElementById('reg-name')?.value?.trim();
  const email = document.getElementById('reg-email')?.value?.trim();
  const pass = document.getElementById('reg-pass')?.value;
  const errEl = document.getElementById('reg-err');

  if (!name || !email || !pass) { errEl.textContent = '↳ Please fill in all fields.'; return; }
  if (pass.length < 8) { errEl.textContent = '↳ Password must be at least 8 characters.'; return; }

  errEl.textContent = 'Creating your account...';
  
  const { data, error } = await sb.auth.signUp({
    email,
    password: pass,
    options: { data: { display_name: name, role: email === ADMIN_EMAIL ? 'admin' : 'user' } }
  });

  console.log('Signup response:', JSON.stringify({ data, error }, null, 2));

  if (error) {
    errEl.textContent = '↳ ' + (error.message || 'Registration failed.');
    return;
  }

  // Upsert profile
  if (data.user) {
    await sb.from('profiles').upsert({
      id: data.user.id,
      display_name: name,
      email: email,
      role: email === ADMIN_EMAIL ? 'admin' : 'user',
      created_at: new Date().toISOString()
    });
  }

  errEl.style.color = '#1900ff';
  errEl.textContent = '✓ Account created! Check your email to confirm, then sign in.';

  if (data.session) {
    setTimeout(() => redirectUser(data.user), 800);
  }
}

function redirectUser(user) {
  if (!user) return;
  const email = user.email || user.user_metadata?.email || '';
  const role = user.user_metadata?.role || '';
  if (email === ADMIN_EMAIL || role === 'admin') {
    window.location.href = 'admin.html';
  } else {
    window.location.href = 'chat.html';
  }
}

async function checkAuth() {
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

async function getProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  return data;
}

async function signOut() {
  await sb.auth.signOut();
  window.location.href = 'index.html';
}

window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.redirectUser = redirectUser;
window.checkAuth = checkAuth;
window.getProfile = getProfile;
window.signOut = signOut;

// Auto-redirect if already signed in (on index page)
if (window.location.pathname.includes('index') || window.location.pathname === '/' || window.location.pathname.endsWith('/mindspace/')) {
  sb.auth.getSession().then(({ data: { session } }) => {
    if (session) redirectUser(session.user);
  });
}