import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { Env } from './index';

import creds from '../credentials.json';
// Eliminamos el wrapper de Node para compatibilidad con Cloudflare Workers


interface ReceiptData {
    email: string;
    amount: string;
    imageLink: string;
    validReceipt: boolean;
    operationCode?: string;
    date: string;
}

interface RequestData {
    email: string;
    imageLink: string;
}


async function ocrReceipt(apiKey: string, imageLink: string): Promise<string> {
    try {
        const form = new FormData();
        form.append('apikey', apiKey);
        form.append('url', imageLink);
        form.append('language', 'spa');
        form.append('OCREngine', '2');

        const resp = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            body: form,
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`OCR API error: ${resp.status} ${text}`);
        }
        const json: any = await resp.json();
        const parsed = json?.ParsedResults?.[0]?.ParsedText ?? '';
        return typeof parsed === 'string' ? parsed : '';
    } catch (error) {
        throw new Error('OCR processing failed', { cause: error });
    }
}

function extractOperationCode(ocrResult: string): string {
    const re = /\b\d{7,}\b/;
    const match = re.exec(ocrResult);
    return match ? match[0] : 'NOT_FOUND';
}


function extractAmount(ocrResult: string): string {
    const re = /S\/\s*(\d{1,3}(?:,\d{3})*\.?\d{2})/;
    const match = re.exec(ocrResult);
    return match ? match[1] : 'NOT_FOUND';
}

function validateReceipt(targetName: string, targetPhone: string, ocrResult: string): boolean {

    const targetNameClean = process.env.VALIDATION_TARGET_NAME?.trim();
    const targetPhoneClean = process.env.VALIDATION_TARGET_PHONE?.trim();

    if (!targetNameClean || !targetPhoneClean) {
        console.error("ERROR: Faltan las variables de entorno VALIDATION_TARGET_NAME o VALIDATION_TARGET_PHONE");
        return false;
    }
    const nameRegex = new RegExp(targetName, 'i');
    const hasName = nameRegex.test(ocrResult);

    const hasPhonePattern = ocrResult.includes(targetPhone);

    return hasName && hasPhonePattern;
}


function extractDate(ocrResult: string): string {
    const dateRe = /(\d{1,2}\s+[a-zA-Z]{3}\.?\s+\d{4})/;
    const timeRe = /(\d{1,2}:\d{2}\s+[ap]\.\?\s*m\.?)/i;
    const dateMatch = dateRe.exec(ocrResult);
    const timeMatch = timeRe.exec(ocrResult);

    const datePart = dateMatch ? dateMatch[0] : '';
    const timePart = timeMatch ? timeMatch[0] : '';

    if (datePart && timePart) {
        return `${datePart} ${timePart}`;
    }

    return datePart || timePart || 'NOT_FOUND';
}

async function createReceiptData(email: string, imageLink: string, env: Env): Promise<ReceiptData> {
    const ocrResult = await ocrReceipt(env.OCR_API_KEY, imageLink);
    const operationCode = extractOperationCode(ocrResult);
    const amount = extractAmount(ocrResult);
    const date = extractDate(ocrResult);
    const validReceipt = operationCode !== 'NOT_FOUND' && amount !== 'NOT_FOUND' && date !== 'NOT_FOUND'
        && validateReceipt(env.VALIDATION_TARGET_NAME, env.VALIDATION_TARGET_PHONE, ocrResult);

    return {
        email,
        amount,
        imageLink,
        validReceipt,
        operationCode: validReceipt ? operationCode : undefined,
        date,
    };
}

async function authenticate(env: Env): Promise<GoogleSpreadsheet> {
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(env.GOOGLE_SHEET_ID, serviceAccountAuth);
    return doc;
}

async function prepareDoc(env: Env): Promise<GoogleSpreadsheetWorksheet> {

    const doc = await authenticate(env);
    await doc.loadInfo();

    const sheet = doc.sheetsByIndex[0];
    return sheet;
}


async function updateSheet(sheet: GoogleSpreadsheetWorksheet, data: ReceiptData) {
    await sheet.addRow({
        "id": generateId(),
        "email": data.email,
        "amount": data.amount,
        "imageLink": data.imageLink,
        "validReceipt": data.validReceipt,
        "operationCode": data.operationCode || '',
        "date": data.date,
    });

}

function generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version (4) and variant (RFC 4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

export async function processReceipt(data: RequestData, env: Env) {
    console.log("Procesando recibo para:", data.email);
    const sheet = await prepareDoc(env);
    const receiptData = await createReceiptData(data.email, data.imageLink, env);
    await updateSheet(sheet, receiptData);
    console.log("Sheet actualizado correctamente");
}