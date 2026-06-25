import type { User, UpsertUser } from "@shared/models/auth";
import { pool } from "../../storage";

export interface IAuthStorage {
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;
}

class AuthStorage implements IAuthStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await pool.query(
      `SELECT id, email, first_name as "firstName", last_name as "lastName", 
              profile_image_url as "profileImageUrl", created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || undefined;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const result = await pool.query(
      `INSERT INTO users (id, email, first_name, last_name, profile_image_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE($2, users.email),
         first_name = COALESCE($3, users.first_name),
         last_name = COALESCE($4, users.last_name),
         profile_image_url = COALESCE($5, users.profile_image_url),
         updated_at = NOW()
       RETURNING id, email, first_name as "firstName", last_name as "lastName",
                 profile_image_url as "profileImageUrl", created_at as "createdAt", updated_at as "updatedAt"`,
      [userData.id, userData.email || null, userData.firstName || null, userData.lastName || null, userData.profileImageUrl || null]
    );
    return result.rows[0];
  }
}

export const authStorage = new AuthStorage();
