import { Webhook } from 'svix';
import { Resend } from 'resend';

export interface Env {
	RESEND_WEBHOOK_SECRET: string;
	RESEND_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// 1. Validación de seguridad (Igual que antes)
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

		const payload = await request.text();
		const headers = {
			'svix-id': request.headers.get('svix-id')!,
			'svix-timestamp': request.headers.get('svix-timestamp')!,
			'svix-signature': request.headers.get('svix-signature')!,
		};

		try {
			const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
			const evt = wh.verify(payload, headers) as any;

			console.log('EVENTO COMPLETO RECIBIDO:', JSON.stringify(evt, null, 2)); // <--- ESTO ES LA CLAVE

			if (evt.type === 'email.received') {
				const emailId = evt.data.email_id;

				if (emailId) {
					ctx.waitUntil(processPaymentEmail(emailId, env));
				} else {
					console.error("No se encontró email_id en el evento");
				}
			}
		} catch (err) {
			return new Response('Error verifying webhook', { status: 400 });
		}

		return new Response('Webhook received', { status: 200 });
	},
};

async function processPaymentEmail(emailId: string, env: Env) {
	const resend = new Resend(env.RESEND_API_KEY);

	// A. Obtener el contenido del correo (Texto y HTML)
	const { data: emailData, error } = await resend.emails.get(emailId);
	if (error || !emailData) return console.error('Error fetching email:', error);

	// B. Parsear el cuerpo del mensaje (Buscamos "Correo:" y "Numero:")
	// El texto suele venir en emailData.text
	const textBody = emailData.text || '';

	// Usamos Regex simple para extraer los datos
	const correoMatch = textBody.match(/Correo:\s*([^\s\n]+)/i);
	const numeroMatch = textBody.match(/Numero:\s*([^\s\n]+)/i);

	const usuarioCorreo = correoMatch ? correoMatch[1] : emailData.from; // Fallback al remitente
	const usuarioNumero = numeroMatch ? numeroMatch[1] : 'No especificado';

	console.log(`Procesando pago de: ${usuarioCorreo} (Tel: ${usuarioNumero})`);

	// C. Obtener Adjuntos (El comprobante)
	// OJO: Resend separa los adjuntos en endpoints específicos para inbound.
	// Primero listamos los adjuntos de este correo.
	const { data: attachments, error: attError } = await resend.emails.receiving.attachments.list({
		emailId: emailId,
	});

	if (attError || !attachments || attachments.length === 0) {
		console.error('No se encontró comprobante adjunto.');
		// Aquí podrías enviar un correo de vuelta diciendo "Falta el comprobante"
		return;
	}

	// Buscamos el archivo.png o similar
	const comprobante = attachments.find(a => a.filename.toLowerCase().endsWith('.png') || a.filename.toLowerCase().endsWith('.jpg'));

	if (comprobante) {
		// D. Descargar el archivo
		// Resend provee una 'download_url' temporal segura [web:41]
		console.log(`Comprobante encontrado: ${comprobante.filename}`);
		console.log(`URL de descarga: ${comprobante.download_url}`);

		// AQUÍ ES DONDE PROCESAS LA IMAGEN
		// Ejemplo: Descargarla y subirla a Cloudflare R2
		/*
		const response = await fetch(comprobante.download_url);
		const blob = await response.blob();
		await env.MY_R2_BUCKET.put(`pagos/${usuarioCorreo}/${comprobante.filename}`, blob);
		*/

		// Una vez guardado, podrías activar la cuenta premium
	} else {
		console.log('El correo tiene adjuntos, pero no es una imagen PNG/JPG válida.');
	}
}
