import express from 'express';

import multer from 'multer';

import {
    login,
    gogoleLogin,
    googleUploadDatabase,
    checkoutSessions,
} from './handlers';



const port = process.env.PORT || 8089;
const app = express();

app.use(express.json());

app.all('*', function (req, res, next) {
    const origin = req.get('origin');

    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Content-Length, Authorization, Accept,X-Requested-With');
    res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');

    next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/login', login);
app.post('/google-login', gogoleLogin);
app.post('/google-upload-database', upload.single('file'), googleUploadDatabase);
app.post('/stripe-checkout-sessions', checkoutSessions);

app.listen(port, () => {
    console.log(`Server started on ${port}`);
});
