// supabase/functions/send-push/index.ts
// ============================================================
// Deploy this with: npx supabase functions deploy send-push
//
// Set these secrets in your Supabase project:
//   npx supabase secrets set VAPID_PRIVATE_KEY=<your_private_key>
//   npx supabase secrets set VAPID_PUBLIC_KEY=<your_public_key>
//   npx supabase secrets set VAPID_EMAIL=mailto:admin@mindspace.com
// ============================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.6';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Only allow authenticated admins/superadmins
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    // Verify the caller is admin/superadmin
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: corsHeaders });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || !['admin', 'superadmin'].includes(profile.role)) {
      return new Response(JSON.stringify({ error: 'Forbidden — admin role required' }), { status: 403, headers: corsHeaders });
    }

    // Setup VAPID
    webpush.setVapidDetails(
      Deno.env.get('VAPID_EMAIL') ?? 'mailto:admin@mindspace.com',
      Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
      Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
    );

    const body = await req.json();
    const { targetUserId, broadcast, notification } = body;

    // Build admin Supabase client for reading subscriptions
    const adminSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch subscriptions
    let subsQuery = adminSupabase.from('push_subscriptions').select('*');
    if (!broadcast && targetUserId) {
      subsQuery = subsQuery.eq('user_id', targetUserId);
    }

    const { data: subscriptions, error: subsError } = await subsQuery;
    if (subsError) {
      return new Response(JSON.stringify({ error: subsError.message }), { status: 500, headers: corsHeaders });
    }

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscriptions found' }), { headers: corsHeaders });
    }

    // Send to each subscription
    const payload = JSON.stringify({
      title: notification.title || 'MindSpace',
      body: notification.body || 'You have a new message.',
      url: notification.url || '/chat.html',
      type: notification.type || 'message',
      timestamp: Date.now()
    });

    const results = await Promise.allSettled(
      subscriptions.map(sub =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
          },
          payload,
          { TTL: 86400 } // Deliver within 24 hours
        )
      )
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Clean up expired subscriptions (410 Gone)
    const expiredEndpoints = results
      .map((r, i) => r.status === 'rejected' && r.reason?.statusCode === 410 ? subscriptions[i].endpoint : null)
      .filter(Boolean);

    if (expiredEndpoints.length > 0) {
      await adminSupabase
        .from('push_subscriptions')
        .delete()
        .in('endpoint', expiredEndpoints);
    }

    return new Response(
      JSON.stringify({ sent, failed, total: subscriptions.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('[send-push] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders
    });
  }
});