import bcrypt from 'bcryptjs';
import {Pool} from 'pg';
const username=process.env.ADMIN_USERNAME,password=process.env.ADMIN_PASSWORD;
if(!username||!password||password.length<14||!process.env.DATABASE_URL){console.error('Set DATABASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD (14+ characters)');process.exit(1);}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{const hash=await bcrypt.hash(password,12);await pool.query('INSERT INTO admins(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash',[username,hash]);console.log('Admin account configured');}finally{await pool.end();}
