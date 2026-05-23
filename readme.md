🚀 Step 1: Install Vercel CLI

Open terminal in your React project folder:

npm install -g vercel
🚀 Step 2: Login to Vercel
vercel login

👉 It will ask for email → verify via OTP

🚀 Step 3: Build your React app
npm run build

👉 This creates a build/ folder

🚀 Step 4: Deploy 🚀
vercel

It will ask some questions:

Set up and deploy? → Y
Which scope? → select your account
Link to existing project? → N
Project name → press Enter (or type name)
Directory → ./ (default)
Override settings? → N
🌐 After deployment

You’ll get a URL like:

https://your-project.vercel.app
🔁 For future updates

Just run:

vercel --prod