import { User } from 'src/user/entities/user.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OtpType {
  VERIFICATION = 'verification',
  PASS_RESET = 'pass_reset',
}

/**
 * Otp — a one-time password row.
 *
 * Cardinality (per Lesson 02):
 *   Otp M — many to User (a user has many OTPs over time: verification, password reset, etc.).
 *
 * - Owning side: Otp (Otp holds user_id FK via @JoinColumn).
 * - Inverse side: User.otps (@OneToMany).
 * - FK is NOT unique — this is 1:N, not 1:1.
 * - onDelete: CASCADE — when a user is hard-deleted, their OTPs go too (GDPR cleanup).
 * - Indexed on user_id via @Index (1:N support).
 */
@Entity()
export class Otp {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.otps, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Index()
  @Column({ type: 'enum', enum: OtpType })
  OtpType: OtpType;

  @Column({ type: 'varchar', length: 6 })
  oneTimeCode: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;
}