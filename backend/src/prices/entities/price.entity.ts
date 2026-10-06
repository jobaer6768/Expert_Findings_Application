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
 * Price — a fee model (hourly, per-consultation, etc.) tied to a Category.
 *
 * Cardinality notes (per Lesson 02):
 *   - Price M — 1 Category (Category 1—N Prices). Owning side: Price holds category_id.
 *   - Price M — N Expert via implicit pivot `expert_prices`. Inverse side: declared here.
 *
 * Index on category_id ensures the Category 1—N Price lookup is O(log n).
 */
@Entity()
@Index('idx_prices_category_id', ['category'])
export class Price {
  @PrimaryGeneratedColumn()
  id!: number;

  //   hourly, per-consultation, yearly, monthly etc...
  @Column({ type: 'varchar', nullable: true })
  type!: string | null;

  @Column({ type: 'int' })
  fee!: number;

  @ManyToOne(() => Category, (category) => category.prices, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'category_id' })
  category!: Category;

  // Inverse side of Expert M:N via expert_prices pivot.
  @ManyToMany(() => Expert, (expert) => expert.prices)
  experts?: Expert[];
}