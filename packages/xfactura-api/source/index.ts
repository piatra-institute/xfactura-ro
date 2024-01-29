import express from 'express';

import multer from 'multer';

import {
    login,
    gogoleLogin,
    googleUploadDatabase,
    checkoutSessions,
} from './handlers';



const port = 8089;
const app = express();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/login', login);
app.post('/google-login', gogoleLogin);
app.post('/google-upload-database', upload.single('file'), googleUploadDatabase);
app.post('/stripe-checkout-sessions', checkoutSessions);

app.listen(port, () => {
    console.log(`Server started on ${port}`);
});
