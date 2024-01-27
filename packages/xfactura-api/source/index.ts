import express from 'express';

import multer from 'multer';

import {
    login,
    uploadDatabaseGoogleDrive,
} from './handlers';



const port = 8089;
const app = express();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/login', login);
app.post('/upload-database-google-drive', upload.single('file'), uploadDatabaseGoogleDrive);

app.listen(port, () => {
    console.log(`Server started on ${port}`);
});
