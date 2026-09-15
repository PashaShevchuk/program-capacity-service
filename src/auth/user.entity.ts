import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  /** May create programs and change credit limits. */
  Admin = 'admin',
  /** May reserve, release and read capacity. */
  Client = 'client',
  /** Read-only access. */
  Viewer = 'viewer',
}

/**
 * An operator or service account that can call the API.
 * Local credentials keep the service runnable with just `docker compose up`;
 * in a real deployment this table gives way to an identity provider.
 */
@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Unique case-insensitively; the database index is on `lower(email)`. */
  @Column({ type: 'varchar', length: 320 })
  email: string;

  /** bcrypt hash. The plaintext never leaves the request handler. */
  @Column({ name: 'password_hash', type: 'varchar', length: 100 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'jsonb', default: () => `'["client"]'::jsonb` })
  roles: UserRole[];

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
