import express from 'express';
import cookieParser from 'cookie-parser';

import multer from 'multer';

import {
    home,
    getUser,
    companyDetails,
    logout,
    googleLogin,
    googleUploadDatabase,
    checkoutSessions,
    processIntelligentAct,
    storePrompt,
} from './handlers';



const port = process.env.PORT || 8089;
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/favicon.ico', express.static('favicon.ico'));

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

app.get('/', home);
app.post('/get-user', getUser);
app.post('/company-details', companyDetails);
app.post('/logout', logout);
app.post('/google-login', googleLogin);
app.post('/google-upload-database', upload.single('file'), googleUploadDatabase);
app.get('/stripe-checkout-sessions', checkoutSessions);
app.post('/stripe-checkout-sessions', checkoutSessions);
app.post('/process-intelligent-act', processIntelligentAct);
app.post('/store-prompt', storePrompt);

app.listen(port, () => {
    console.log(`Server started on ${port}`);
});
