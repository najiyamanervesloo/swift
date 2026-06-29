require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const Razorpay = require('razorpay');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Ensure temp_uploads folder exists
const uploadDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage engine configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only PDF and image (PNG/JPG) formats are supported.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Load settings from settings.json
const settingsPath = path.join(__dirname, 'settings.json');
let appSettings = {
    activePrinterId: "",
    rates: {
        mono: 2.00,
        color: 10.00,
        a4: 0.00,
        a3: 5.00,
        receipt: -0.50,
        duplex: 1.00
    },
    enableCounterPayment: true,
    serviceFee: 0.00,
    paymentMode: "razorpay",
    upiId: "",
    razorpayKeyId: "",
    razorpayKeySecret: ""
};

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            appSettings = JSON.parse(data);
            console.log('Settings loaded successfully.');
        } else {
            saveSettings();
        }
    } catch (err) {
        console.error('Error loading settings:', err.message);
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
        console.log('Settings saved to settings.json.');
    } catch (err) {
        console.error('Error saving settings:', err.message);
    }
}

loadSettings();

// In-memory Job Database (mimics real database for admin dashboard)
let jobHistory = [
    {
        id: "SP-4921",
        fileName: "Aadhaar_Card_Front.jpg",
        timestamp: new Date(Date.now() - 3600000).toLocaleString(),
        colorMode: "COLOR",
        paperSize: "A4",
        copies: 2,
        cost: "₹20.00",
        status: "PRINTED"
    },
    {
        id: "SP-4920",
        fileName: "Resume_June_2026.pdf",
        timestamp: new Date(Date.now() - 7200000).toLocaleString(),
        colorMode: "MONO",
        paperSize: "A4",
        copies: 1,
        cost: "₹2.00",
        status: "PRINTED"
    }
];

// Active Server-Sent Events (SSE) clients for printer updates
let sseClients = [];

// Helper to broadcast print event to all frontend consoles
function broadcastPrintEvent(jobData) {
    console.log(`Broadcasting print event for Job #${jobData.id} to ${sseClients.length} clients`);
    sseClients.forEach(client => {
        client.write(`data: ${JSON.stringify(jobData)}\n\n`);
    });
}

// Check configuration status of Razorpay & PrintNode
function getApiConfigStatus() {
    const keyId = appSettings.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
    const keySecret = appSettings.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;

    const isRazorpayConfigured = 
        keyId && 
        keyId !== 'rzp_test_change_me' && 
        keySecret && 
        keySecret !== 'your_razorpay_secret_here';

    const isPrintNodeConfigured = 
        process.env.PRINTNODE_API_KEY && 
        process.env.PRINTNODE_API_KEY !== 'your_printnode_api_key_here';

    return {
        paymentMode: appSettings.paymentMode || "razorpay",
        upiId: appSettings.upiId || "",
        razorpayEnabled: !!isRazorpayConfigured,
        printNodeEnabled: !!isPrintNodeConfigured,
        razorpayKeyId: isRazorpayConfigured ? keyId : null
    };
}

// Initialize Razorpay if keys are configured
let razorpayClient = null;
if (getApiConfigStatus().razorpayEnabled) {
    razorpayClient = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
}

// Re-initialize Razorpay on runtime settings change
function updateRazorpayClient() {
    const status = getApiConfigStatus();
    const keyId = appSettings.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
    const keySecret = appSettings.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET;

    if (status.razorpayEnabled) {
        razorpayClient = new Razorpay({
            key_id: keyId,
            key_secret: keySecret
        });
        console.log("Razorpay client re-initialized with dynamic keys.");
    } else {
        razorpayClient = null;
        console.log("Razorpay client disabled due to default keys.");
    }
}

// -------------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------------

// Serve dashboard config & settings
app.get('/api/config', (req, res) => {
    res.json({
        settings: appSettings,
        apiStatus: getApiConfigStatus()
    });
});

// Fetch active printers from PrintNode API
app.get('/api/printers', async (req, res) => {
    const status = getApiConfigStatus();
    if (!status.printNodeEnabled) {
        return res.json([
            { id: "mock-hp", name: "HP DeskJet 2300 (Mock Sandbox)", state: "online" },
            { id: "mock-thermal", name: "Epson TM-T88 (Mock Thermal)", state: "online" }
        ]);
    }

    try {
        const response = await axios.get('https://api.printnode.com/printers', {
            auth: {
                username: process.env.PRINTNODE_API_KEY,
                password: ''
            },
            timeout: 5000
        });
        res.json(response.data.map(p => ({
            id: p.id,
            name: `${p.name} (${p.computer.name})`,
            state: p.state
        })));
    } catch (err) {
        console.error('Error fetching printers from PrintNode:', err.message);
        res.status(500).json({ error: 'Failed to retrieve printers from PrintNode.' });
    }
});

// Update app configurations
app.post('/api/settings', (req, res) => {
    const { activePrinterId, rates, enableCounterPayment, serviceFee, paymentMode, upiId, razorpayKeyId, razorpayKeySecret, printNodeApiKey } = req.body;

    if (activePrinterId !== undefined) appSettings.activePrinterId = activePrinterId.toString();
    if (rates !== undefined) appSettings.rates = { ...appSettings.rates, ...rates };
    if (enableCounterPayment !== undefined) appSettings.enableCounterPayment = !!enableCounterPayment;
    if (serviceFee !== undefined) appSettings.serviceFee = parseFloat(serviceFee) || 0;
    
    if (paymentMode !== undefined) appSettings.paymentMode = paymentMode.toString();
    if (upiId !== undefined) appSettings.upiId = upiId.toString();
    if (razorpayKeyId !== undefined) appSettings.razorpayKeyId = razorpayKeyId.toString();
    if (razorpayKeySecret !== undefined) appSettings.razorpayKeySecret = razorpayKeySecret.toString();

    // Save to settings.json
    saveSettings();

    // Optionally update keys dynamically if sent from UI (saved to memory & .env)
    if (printNodeApiKey) process.env.PRINTNODE_API_KEY = printNodeApiKey;

    updateRazorpayClient();

    res.json({ success: true, settings: appSettings, apiStatus: getApiConfigStatus() });
});

// Get recent job history logs
app.get('/api/jobs', (req, res) => {
    res.json(jobHistory);
});

// Clear job history
app.post('/api/jobs/clear', (req, res) => {
    jobHistory = [];
    res.json({ success: true });
});

// Handle incoming file uploads
app.post('/api/upload-temp', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file was uploaded.' });
    }
    
    res.json({
        success: true,
        tempFileId: req.file.filename,
        originalName: req.file.originalname,
        sizeBytes: req.file.size
    });
});

// Helper to calculate exact cost on the server to prevent tampering
function calculatePrintCost(config) {
    const { colorMode, paperSize, duplex, copies } = config;
    const rates = appSettings.rates;

    const baseRate = (colorMode === 'color') ? rates.color : rates.mono;
    
    let sizeRate = 0;
    if (paperSize === 'a3') sizeRate = rates.a3;
    if (paperSize === 'receipt') sizeRate = rates.receipt;

    const duplexRate = duplex ? rates.duplex : 0;

    const calculatedSubtotal = ((baseRate + sizeRate + duplexRate) * copies) + (appSettings.serviceFee || 0);
    return Math.max(1, calculatedSubtotal); // minimum ₹1
}

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    const { colorMode, paperSize, duplex, copies, paymentMethod, tempFileId, originalName } = req.body;
    
    // Server-side cost calculation
    const totalRupees = calculatePrintCost({ colorMode, paperSize, duplex, copies });
    const totalPaise = Math.round(totalRupees * 100);

    // If client requested Pay at Counter
    if (paymentMethod === 'counter') {
        if (!appSettings.enableCounterPayment) {
            return res.status(400).json({ error: 'Cash counter payments are currently disabled by merchant.' });
        }

        const jobId = "SP-" + Math.floor(Math.random() * 9000 + 1000);
        
        const jobLog = {
            id: jobId,
            fileName: originalName || 'Document',
            tempFileId: tempFileId,
            timestamp: new Date().toLocaleString(),
            colorMode: colorMode.toUpperCase(),
            paperSize: paperSize.toUpperCase(),
            copies: parseInt(copies),
            cost: `₹${totalRupees.toFixed(2)}`,
            status: "PENDING_CASH",
            paymentMethod: "counter",
            printConfig: { colorMode, paperSize, duplex, copies, originalName }
        };
        jobHistory.unshift(jobLog);
        
        // Broadcast the pending job via SSE to update merchant dashboard
        broadcastPrintEvent({
            id: jobId,
            fileName: originalName,
            colorMode: colorMode,
            paperSize: paperSize,
            copies: copies,
            cost: totalRupees,
            status: "PENDING_CASH"
        });

        return res.json({
            counter: true,
            jobId: jobId,
            totalRupees: totalRupees
        });
    }

    const status = getApiConfigStatus();

    // If online payment is routed via UPI ID
    if (status.paymentMode === 'upi' && status.upiId) {
        const jobId = "SP-" + Math.floor(Math.random() * 9000 + 1000);
        
        const jobLog = {
            id: jobId,
            fileName: originalName || 'Document',
            tempFileId: tempFileId,
            timestamp: new Date().toLocaleString(),
            colorMode: colorMode.toUpperCase(),
            paperSize: paperSize.toUpperCase(),
            copies: parseInt(copies),
            cost: `₹${totalRupees.toFixed(2)}`,
            status: "PENDING_UPI",
            paymentMethod: "upi",
            printConfig: { colorMode, paperSize, duplex, copies, originalName }
        };
        jobHistory.unshift(jobLog);
        
        // Broadcast the pending job via SSE to update merchant dashboard
        broadcastPrintEvent({
            id: jobId,
            fileName: originalName,
            colorMode: colorMode,
            paperSize: paperSize,
            copies: copies,
            cost: totalRupees,
            status: "PENDING_UPI"
        });

        return res.json({
            upi: true,
            upiId: status.upiId,
            jobId: jobId,
            totalRupees: totalRupees,
            upiLink: `upi://pay?pa=${status.upiId}&pn=SwiftPrint&am=${totalRupees.toFixed(2)}&cu=INR&tn=${jobId}`
        });
    }

    if (!status.razorpayEnabled) {
        // Return dummy order details for sandbox simulation
        const mockOrderId = 'order_mock_' + crypto.randomBytes(8).toString('hex');
        return res.json({
            sandbox: true,
            id: mockOrderId,
            amount: totalPaise,
            currency: 'INR',
            totalRupees: totalRupees
        });
    }

    try {
        const order = await razorpayClient.orders.create({
            amount: totalPaise,
            currency: 'INR',
            receipt: 'receipt_job_' + Date.now(),
            notes: {
                colorMode,
                paperSize,
                duplex: duplex ? 'yes' : 'no',
                copies: copies.toString()
            }
        });
        res.json({
            sandbox: false,
            id: order.id,
            amount: order.amount,
            currency: order.currency,
            totalRupees: totalRupees
        });
    } catch (err) {
        console.error('Error generating Razorpay Order:', err.message);
        res.status(500).json({ error: 'Payment gateway initialization failed.' });
    }
});

// Convert uploaded image to high-res PDF in-memory buffer
function convertImageToPdfBuffer(imagePath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ autoFirstPage: false });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });
        doc.on('error', (err) => {
            reject(err);
        });

        // Use standard A4 page size: 595.28 x 841.89 points
        doc.addPage({ size: 'A4', margin: 0 });
        doc.image(imagePath, 0, 0, {
            fit: [595.28, 841.89],
            align: 'center',
            valign: 'center'
        });
        doc.end();
    });
}

// Processes the print transmission to PrintNode and SSE clients
async function processVerifiedPrintJob(tempFileId, printConfig, totalCost, existingJobId = null) {
    const filePath = path.join(uploadDir, tempFileId);
    if (!fs.existsSync(filePath)) {
        throw new Error('File not found on server.');
    }

    const { colorMode, paperSize, duplex, copies, originalName } = printConfig;
    let pdfBase64 = '';

    // Convert PNG/JPG to PDF, or read PDF directly
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
        const fileData = fs.readFileSync(filePath);
        pdfBase64 = fileData.toString('base64');
    } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        const pdfBuffer = await convertImageToPdfBuffer(filePath);
        pdfBase64 = pdfBuffer.toString('base64');
    } else {
        throw new Error('Unsupported file extension.');
    }

    // Attempt sending to PrintNode
    const configStatus = getApiConfigStatus();
    let printNodeJobId = null;

    if (configStatus.printNodeEnabled && appSettings.activePrinterId) {
        try {
            console.log(`Sending Print Job to PrintNode Printer ID: ${appSettings.activePrinterId}`);
            const response = await axios.post('https://api.printnode.com/printjobs', {
                printerId: parseInt(appSettings.activePrinterId),
                title: `SwiftPrint - ${originalName}`,
                contentType: 'pdf_base64',
                content: pdfBase64,
                source: 'SwiftPrint Cloud Portal'
            }, {
                auth: {
                    username: process.env.PRINTNODE_API_KEY,
                    password: ''
                },
                timeout: 10000
            });
            printNodeJobId = response.data;
            console.log(`PrintNode Job dispatched. Job ID: ${printNodeJobId}`);
        } catch (err) {
            console.error('PrintNode API submission failed:', err.response ? err.response.data : err.message);
            // Non-blocking: We continue so the web UI simulator still updates.
        }
    } else {
        console.log(`PrintNode transmission skipped: activePrinterId="${appSettings.activePrinterId}", configured=${configStatus.printNodeEnabled}`);
    }

    // Generate unique internal job payload
    const jobId = existingJobId || ("SP-" + Math.floor(Math.random() * 9000 + 1000));
    
    if (existingJobId) {
        // Update status of the existing job log
        const jobIndex = jobHistory.findIndex(j => j.id === existingJobId);
        if (jobIndex !== -1) {
            jobHistory[jobIndex].status = "PRINTED";
        }
    } else {
        const jobLog = {
            id: jobId,
            fileName: originalName,
            timestamp: new Date().toLocaleString(),
            colorMode: colorMode.toUpperCase(),
            paperSize: paperSize.toUpperCase(),
            copies: parseInt(copies),
            cost: `₹${totalCost.toFixed(2)}`,
            status: "PRINTED"
        };
        jobHistory.unshift(jobLog);
    }
    
    // Broadcast message to SSE virtual printer clients
    broadcastPrintEvent({
        id: jobId,
        fileName: originalName,
        colorMode: colorMode,
        paperSize: paperSize,
        copies: copies,
        cost: totalCost,
        status: "PRINTING",
        fileContentBase64: ['png', 'jpg', 'jpeg'].includes(ext.substring(1)) ? `data:image/${ext.substring(1)};base64,` + fs.readFileSync(filePath).toString('base64') : null,
        isPdf: ext === '.pdf'
    });

    // Cleanup temp uploaded file asynchronously after a short delay
    setTimeout(() => {
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.error(`Error deleting temp file ${tempFileId}:`, err.message);
                else console.log(`Deleted temp file: ${tempFileId}`);
            });
        }
    }, 5000);

    return jobId;
}

// Verify Payment and Execute Print
app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, tempFileId, printConfig } = req.body;

    const totalCost = calculatePrintCost(printConfig);
    const status = getApiConfigStatus();

    // If sandbox simulated checkout
    if (!status.razorpayEnabled && razorpay_order_id.startsWith('order_mock_')) {
        try {
            const internalJobId = await processVerifiedPrintJob(tempFileId, printConfig, totalCost);
            return res.json({ success: true, message: 'Print job dispatched (Mock Success)', jobId: internalJobId });
        } catch (err) {
            console.error('Error processing mock print job:', err.message);
            return res.status(500).json({ error: err.message });
        }
    }

    // Live Razorpay validation
    try {
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature === razorpay_signature) {
            console.log(`Payment signature verified. Processing print job: ${tempFileId}`);
            const internalJobId = await processVerifiedPrintJob(tempFileId, printConfig, totalCost);
            res.json({ success: true, message: 'Payment verified and print job sent!', jobId: internalJobId });
        } else {
            res.status(400).json({ error: 'Signature verification failed. Invalid transaction.' });
        }
    } catch (err) {
        console.error('Payment verification failed:', err.message);
        res.status(500).json({ error: 'Transaction validation processing failed.' });
    }
});

// Approve counter payment print job manually
app.post('/api/jobs/:id/approve', async (req, res) => {
    const jobId = req.params.id;
    const job = jobHistory.find(j => j.id === jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status !== 'PENDING_CASH' && job.status !== 'PENDING_UPI') {
        return res.status(400).json({ error: 'Job is not pending approval.' });
    }

    try {
        const totalCost = parseFloat(job.cost.replace('₹', ''));
        // Execute physical & virtual print sequence
        await processVerifiedPrintJob(job.tempFileId, job.printConfig, totalCost, jobId);
        res.json({ success: true, message: 'Print job approved and printed successfully.' });
    } catch (err) {
        console.error('Manual approval failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Reject/Cancel counter payment print job manually
app.post('/api/jobs/:id/reject', (req, res) => {
    const jobId = req.params.id;
    const jobIndex = jobHistory.findIndex(j => j.id === jobId);

    if (jobIndex === -1) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    const job = jobHistory[jobIndex];
    if (job.status !== 'PENDING_CASH' && job.status !== 'PENDING_UPI') {
        return res.status(400).json({ error: 'Job is not pending approval.' });
    }

    // Clean up temp file
    if (job.tempFileId) {
        const filePath = path.join(uploadDir, job.tempFileId);
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.error(`Error deleting temp file ${job.tempFileId}:`, err.message);
            });
        }
    }

    // Update status to CANCELLED
    jobHistory[jobIndex].status = "CANCELLED";

    // Broadcast update via SSE
    broadcastPrintEvent({
        id: jobId,
        status: "CANCELLED"
    });

    res.json({ success: true, message: 'Job successfully cancelled and deleted.' });
});

// SSE endpoint to push printer events in real-time
app.get('/api/printer-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Establish stream link

    console.log('New client connected to printer-stream');
    sseClients.push(res);

    req.on('close', () => {
        console.log('Client disconnected from printer-stream');
        sseClients = sseClients.filter(client => client !== res);
    });
});

// Fallback to client site root
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`SwiftPrint live server running on http://localhost:${PORT}`);
});
