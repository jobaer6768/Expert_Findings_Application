import { Category } from 'src/categories/entities/category.entity';
import { Expert } from 'src/experts/entities/expert.entity';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Qualification — a credential an Expert may have (BSc, MD, etc.).
 *
 * Cardinality notes (per Lesson 02):
 *   - Qualification M — 1 Category (Category 1—N Qualifications).
 *     Owning side: Qualification holds category_id via @JoinColumn.
 *   - Qualification M — N Expert via implicit pivot `expert_qualifications`.
 *     Inverse side: declared here without @JoinTable (the owning side is Expert).
 *
 * Index on category_id ensures Categories 1—N Qualification lookups are O(log n).
 */
@Entity()
@Index('idx_qualifications_category_id', ['category'])
export class Qualification {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @ManyToOne(() => Category, (category) => category.qualifications, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  // Inverse side of Expert M:N via expert_qualifications pivot.
  @ManyToMany(() => Expert, (expert) => expert.qualifications)
  experts?: Expert[];
}