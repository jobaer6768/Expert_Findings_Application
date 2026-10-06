import { Expert } from 'src/experts/entities/expert.entity';
import { Otp } from 'src/otp/entities/otp.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  CLIENT = 'client',
  EXPERT = 'expert',
}

export enum UserStatus {
  ACTIVE = 'active',
  DEACTIVE = 'deactive',
  DELETED = 'deleted',
}

/**
 * User — auth identity.
 *
 * Cardinality notes (per Lesson 02):
 *   - User 1 — N Expert (a user may have at most one expert extension in practice;
 *     this is enforced SOFT-1:1 at the DB level via UNIQUE on experts.user_id
 *     added by the migration, but the entity keeps 1:N to match the original
 *     schema and avoid behaviour changes).
 *   - User 1 — N Otp (a user has many OTPs over time: verification, password reset).
 *   - Both are inverse sides. The owning sides are Expert.user and Otp.user.
 */
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 40, unique: true })
  email: string;

  @Column({ type: 'varchar', name: 'pass_hash', select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'boolean', default: false })
  is_email_verified: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Inverse side of User 1—N Expert. Owning side is Expert.user (@JoinColumn user_id).
  @OneToMany(() => Expert, (expert) => expert.user)
  experts: Expert[];

  // Inverse side of User 1—N Otp. Owning side is Otp.user (@JoinColumn user_id).
  @OneToMany(() => Otp, (otp) => otp.user)
  otps: Otp[];
}