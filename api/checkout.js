// api/checkout.js - Vercel Serverless Function
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // CORS設定（全オリジン許可 → テスト後に絞る）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  const stripe_sk = process.env.STRIPE_SECRET_KEY;
  if (!stripe_sk) {
    return res.status(500).json({ ok: false, message: 'Stripe設定がありません' });
  }

  const body = req.body || {};
  const { event_id, event_name, name, email, gender, invited_by, amount } = body;

  if (!event_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ ok: false, message: 'パラメータ不足' });
  }

  // 単発決済（CHARGE-）はadmin.htmlに戻す、通常決済はcheckout.htmlへ
  const isQuickCharge = String(event_id).startsWith('CHARGE-');
  const successUrl = isQuickCharge
    ? 'https://luxepartycom.github.io/event-system/admin.html'
    : 'https://luxepartycom.github.io/event-system/checkout.html?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = isQuickCharge
    ? 'https://luxepartycom.github.io/event-system/admin.html'
    : 'https://luxepartycom.github.io/event-system/index.html?e=' + event_id + '&type=paid';

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('payment_method_types[0]', 'card');
  params.append('line_items[0][price_data][currency]', 'jpy');
  params.append('line_items[0][price_data][unit_amount]', String(amount));
  params.append('line_items[0][price_data][product_data][name]', (event_name || 'イベント') + ' 入場料');
  params.append('line_items[0][quantity]', '1');
  if (email) params.append('customer_email', email);
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('metadata[event_id]', event_id);
  params.append('metadata[name]', name);
  params.append('metadata[email]', email);
  params.append('metadata[gender]', gender || '');
  params.append('metadata[invited_by]', invited_by || '');
  params.append('metadata[amount]', String(amount));

  try {
    const auth = Buffer.from(stripe_sk + ':').toString('base64');
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await stripeRes.json();

    if (data.error) {
      return res.status(400).json({ ok: false, message: 'Stripe: ' + data.error.message });
    }

    return res.status(200).json({ ok: true, checkout_url: data.url, session_id: data.id });

  } catch (err) {
    return res.status(500).json({ ok: false, message: 'エラー: ' + err.message });
  }
}
