const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'rakibkumar151@gmail.com',
        pass: 'ziasmvxfmtaxrxbx'
    }
});

transporter.verify((error, success) => {
    if (error) {
        console.log('[FAIL] Transporter verify error:', error.message);
    } else {
        console.log('[OK] Server is ready to send emails');
        transporter.sendMail({
            from: 'Chet <rakibkumar151@gmail.com>',
            to: 'kuanrhaisn@gmail.com',
            subject: 'Chet OTP Test',
            text: 'Your test OTP is: 123456'
        }, (err, info) => {
            if (err) {
                console.log('[FAIL] Send error:', err.message);
            } else {
                console.log('[OK] Email sent:', info.response);
            }
        });
    }
});
