# How to Push to GitHub

Your code is now committed locally and ready to push to GitHub. Follow these steps:

## Option 1: Create Repository via GitHub Website (Recommended)

1. **Go to GitHub** and log in to your account at https://github.com

2. **Create a new repository:**
   - Click the "+" icon in the top right corner
   - Select "New repository"
   - Name it: `sneaker-auction` (or any name you prefer)
   - Description: "Khloe's Kicks - Sneaker auction platform"
   - Choose: **Private** (recommended to keep your code private)
   - **DO NOT** initialize with README, .gitignore, or license (we already have these)
   - Click "Create repository"

3. **Connect and push your code:**
   
   After creating the repository, GitHub will show you commands. Run these in your terminal:
   
   ```powershell
   git remote add origin https://github.com/bornofthemind2/sneaker-auction.git
   git branch -M main
   git push -u origin main
   ```
   
   Replace `bornofthemind2/sneaker-auction` with your actual GitHub username and repository name.

4. **Enter credentials when prompted:**
   - Username: bornofthemind2
   - Password: Use a Personal Access Token (not your GitHub password)
   
   If you don't have a token, create one at:
   https://github.com/settings/tokens/new
   - Select: `repo` scope (full control of private repositories)
   - Generate token and copy it
   - Use this token as your password

## Option 2: Quick Commands

If you already created the repository named `sneaker-auction`:

```powershell
cd C:\Users\Admin\sneaker-auction
git remote add origin https://github.com/bornofthemind2/sneaker-auction.git
git branch -M main
git push -u origin main
```

## Verify Your Push

After pushing, visit your repository at:
https://github.com/bornofthemind2/sneaker-auction

You should see all your files there!

## Important Notes

✅ **What's included:**
- All source code files
- Views and templates
- Package.json and dependencies list
- README documentation
- PowerShell startup script

🚫 **What's excluded (via .gitignore):**
- node_modules/ (dependencies)
- .env (environment secrets)
- *.sqlite (database files)
- uploads/ (uploaded files)
- labels/ (shipping labels)

## Future Pushes

After your initial push, you can push future changes with:

```powershell
git add .
git commit -m "Your commit message describing changes"
git push
```

## Need Help?

If you encounter authentication issues:
1. Make sure you're using a Personal Access Token, not your password
2. Check token permissions include `repo` access
3. Try SSH instead of HTTPS (requires SSH key setup)
