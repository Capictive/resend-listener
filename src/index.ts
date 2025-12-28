import { Webhook } from 'svix';
import { Resend } from 'resend';
import { uploadFromBuffer } from './cloudinary'; // Importamos tu función de upload
import { processReceipt } from './utils';        // Importamos tu lógica de OCR/Sheets

export interface Env {
	RESEND_WEBHOOK_SECRET: string;
	RESEND_API_KEY: string;
	CLOUDINARY_CLOUD_NAME: string;
	CLOUDINARY_API_KEY: string;
	CLOUDINARY_API_SECRET: string;
	OCR_API_KEY: string;
	GOOGLE_SHEET_ID: string;
	VALIDATION_TARGET_NAME: string;
	VALIDATION_TARGET_PHONE: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

			if (evt.type === 'email.received') {
				// Para emails recibidos, no uses resend.emails.get (envía 404).
				// Procesamos directamente evt.data y usamos el Receiving API.
				ctx.waitUntil(processPaymentEvent(evt.data, env));
			}
		} catch (err) {
			console.error("Error verifying webhook:", err);
			return new Response('Error verifying webhook', { status: 400 });
		}

		return new Response('Webhook received', { status: 200 });
	},
};

type ReceivingAttachment = {
	filename?: string;
	content_type?: string;
	download_url?: string;
	id?: string;
};
type EventAttachmentMeta = {
	id: string;
	filename?: string;
	content_type?: string;
};

async function processPaymentEvent(evtData: any, env: Env) {
	const resend = new Resend(env.RESEND_API_KEY);

	const emailId = evtData?.email_id;
	if (!emailId) {
		console.error("No se encontró email_id en el evento");
		return;
	}

	// 1) Listar adjuntos del email recibido
	const attachments = await listReceivingAttachments(resend, emailId, env, (evtData?.attachments as EventAttachmentMeta[] | undefined));
	if (!attachments || attachments.length === 0) {
		console.log("El correo no tiene adjuntos.");
		return;
	}

	// 2) Elegir una imagen por filename o content_type
	const imageAttachment = selectImageAttachment(attachments);

	if (!imageAttachment) {
		console.log("No se encontró un archivo de imagen válido en los adjuntos.");
		return;
	}

	// 3) Descargar el contenido usando download_url (válido ~1 hora)
	const downloadUrl = imageAttachment.download_url;
	if (!downloadUrl) {
		console.error("El adjunto no tiene download_url disponible.");
		return;
	}

	try {
		console.log(`Descargando imagen: ${imageAttachment.filename}`);
		const fileBuffer = await downloadAttachmentBuffer(downloadUrl);
		if (!fileBuffer) {
			console.error(`Fallo al descargar ${imageAttachment.filename}`);
			return;
		}

		// 4) Subir a Cloudinary
		const uploadResult = await uploadFromBuffer(fileBuffer, env);
		const imageUrl = uploadResult.secure_url;
		console.log("Imagen subida a Cloudinary:", imageUrl);

		// 5) Procesar con OCR/Sheets
		const senderEmail = getUserEmailFromEvent(evtData) ?? evtData?.from;
		await processReceipt({
			email: senderEmail,
			imageLink: imageUrl
		}, env);

	} catch (err) {
		console.error("Error procesando la imagen o el OCR:", err);
	}
	function getUserEmailFromEvent(evtData: any): string | null {
		const cc = evtData?.cc;
		if (Array.isArray(cc) && cc.length > 0) {
			const first = cc[0];
			if (typeof first === 'string') return first;
			if (first?.email) return first.email;
			if (first?.address) return first.address;
		}
		return null;
	}
}

// Helpers
async function listReceivingAttachments(
	resend: Resend,
	emailId: string,
	env: Env,
	evtAttachments?: EventAttachmentMeta[]
): Promise<ReceivingAttachment[] | null> {
	const receivingClient = (resend as any).attachments?.receiving;
	const hasSdkReceivingList = !!receivingClient && typeof receivingClient.list === 'function';

	if (hasSdkReceivingList) {
		const res = await receivingClient.list({ emailId });
		if (res?.error) {
			console.error('Error al listar adjuntos (Receiving API SDK):', res.error);
			return null;
		}
		return (res?.data ?? null) as ReceivingAttachment[] | null;
	}

	// REST list
	const listed = await listReceivingAttachmentsREST(emailId, env);
	if (listed && listed.length > 0) return listed;

	// Fallback: retrieve by IDs from the event with small retry
	if (evtAttachments && evtAttachments.length > 0) {
		const retrieved = await retrieveReceivingAttachmentsByIds(emailId, evtAttachments, env);
		if (retrieved.length > 0) return retrieved;
	}

	return null;
}

function selectImageAttachment(attachments: ReceivingAttachment[]): ReceivingAttachment | null {
	for (const att of attachments) {
		const byName = att?.filename && /\.(jpg|jpeg|png|webp)$/i.test(att.filename);
		const byType = att?.content_type && String(att.content_type).toLowerCase().startsWith('image/');
		if (byName || byType) return att;
	}
	return null;
}

async function downloadAttachmentBuffer(downloadUrl: string): Promise<Buffer | null> {
	const resp = await fetch(downloadUrl);
	if (resp.ok) {
		const arrayBuffer = await resp.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}
	console.error('Fallo al descargar adjunto', { statusCode: resp.status });
	return null;
}

// Retrieve a single receiving attachment with retry/backoff (handles eventual consistency)
async function retrieveReceivingAttachmentWithRetry(
	emailId: string,
	attachmentId: string,
	env: Env,
	retries: number,
	delayMs: number
): Promise<ReceivingAttachment | null> {
	const url = `https://api.resend.com/emails/receiving/${emailId}/attachments/${attachmentId}`;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const resp = await fetch(url, {
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			}
		});
		if (resp.ok) {
			const json: any = await resp.json();
			const data = json?.data ?? json;
			return {
				filename: data?.filename,
				content_type: data?.content_type,
				download_url: data?.download_url,
				id: attachmentId,
			} as ReceivingAttachment;
		}
		// On 404, wait and retry (download_url may not be ready yet)
		if (resp.status === 404 && attempt < retries) {
			await sleep(delayMs);
			continue;
		}
		const text = await resp.text();
		console.error('Error al obtener adjunto (Receiving API REST):', { statusCode: resp.status, message: text });
		return null;
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function listReceivingAttachmentsREST(emailId: string, env: Env): Promise<ReceivingAttachment[] | null> {
	const url = `https://api.resend.com/emails/receiving/${emailId}/attachments`;
	const resp = await fetch(url, {
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		}
	});
	if (!resp.ok) {
		return null;
	}
	const json: any = await resp.json();
	if (Array.isArray(json?.data)) return json.data as ReceivingAttachment[];
	if (Array.isArray(json)) return json as ReceivingAttachment[];
	return [];
}

async function retrieveReceivingAttachmentsByIds(
	emailId: string,
	evtAttachments: EventAttachmentMeta[],
	env: Env
): Promise<ReceivingAttachment[]> {
	const results: ReceivingAttachment[] = [];
	for (const meta of evtAttachments) {
		const fetched = await retrieveReceivingAttachmentWithRetry(emailId, meta.id, env, 3, 500);
		if (fetched?.download_url) {
			results.push({
				filename: fetched.filename ?? meta.filename,
				content_type: fetched.content_type ?? meta.content_type,
				download_url: fetched.download_url,
				id: meta.id,
			});
		}
	}
	return results;
}
