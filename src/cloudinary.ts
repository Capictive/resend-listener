import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { Env } from './index'; // Importamos la interfaz Env para tipado

export const uploadFromBuffer = (buffer: Buffer, env: Env): Promise<any> => {

    // Configuramos Cloudinary con las variables de entorno del Worker
    cloudinary.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET
    });

    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: "Capictive",
            },
            (error: any, result: any) => {
                if (result) resolve(result);
                else reject(error);
            }
        );

        // Convertimos el buffer en un stream y lo enviamos a Cloudinary
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};
