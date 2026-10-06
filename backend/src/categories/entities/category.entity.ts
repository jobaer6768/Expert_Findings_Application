import { Expert } from 'src/experts/entities/expert.entity';
import { Price } from 'src/prices/entities/price.entity';
import { Qualification } from 'src/qualifications/entities/qualification.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CategoryStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Category — a self-referencing tree of expert categories.
 *
 * Cardinality notes (per Lesson 02):
 *   - Category self-reference: parent_id FK on categories (Categories 1—N Categories).
 *     Owning side: child Category holds parent_id via @JoinColumn.
 *     Inverse side: parent Category.children (@OneToMany).
 *     onDelete: RESTRICT — never silently wipe a sub-tree; admin tool must reassign first.
 *     nullable: true — top-level categories have no parent.
 *   - Category 1 — N Qualification, Price, Expert (each child holds the FK).
 *
 * Note: There is NO standalone `@Column parent_id`. The FK column is created
 * by @JoinColumn on the @ManyToOne. Adding both would create TWO columns.
 */
@Entity()
@Index('idx_categories_parent_id', ['parent'])
export class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string;

  @Column({
    type: 'enum',
    enum: CategoryStatus,
    default: CategoryStatus.ACTIVE,
  })
  status!: CategoryStatus;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updated_at!: Date;

  // Owning side of the self-reference: child Category holds parent_id.
  // @JoinColumn creates the column; no separate @Column parent_id.
  @ManyToOne(() => Category, (category) => category.children, {
    onDelete: 'RESTRICT',
    nullable: true,
  })
  @JoinColumn({ name: 'parent_id' })
  parent!: Category | null;

  // Inverse side of the self-reference.
  @OneToMany(() => Category, (category) => category.parent)
  children!: Category[];

  // Inverse side of Category 1—N Qualification.
  @OneToMany(() => Qualification, (qualification) => qualification.category)
  qualifications!: Qualification[];

  // Inverse side of Category 1—N Price.
  @OneToMany(() => Price, (price) => price.category)
  prices!: Price[];

  // Inverse side of Category 1—N Expert.
  @OneToMany(() => Expert, (expert) => expert.category)
  experts!: Expert[];
}