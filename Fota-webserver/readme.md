# VM Setup


1. Install git and node js

```
sudo apt install git -y
sudo apt install nodejs -y
```

2. Create key to access git repo

```
ls ~/.ssh
ssh-keygen -t rsa -b 4096 -C "emailmu@example.com"
```

enter the generated key to the github repo

3. Clone Repository
```
git clone git@github.com:ReyhanTanjung/GetStok-FMS-FOTA.git
```

4. Install packages
```
sudo npm install -g pm2
npm install
```

5. Buat NGINX config
```
sudo apt install nginx
sudo nano /etc/nginx/sites-available/ota
```
NGINX Config
```
server {
    listen 80;
    server_name your-domain.com; # External IP VM

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```