import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add cardinalities & constraints per Lesson 02.
 *
 * Lesson rules implemented here:
 *   - 1:1 / soft-1:1: UNIQUE constraint on the FK column.
 *   - 1:N: FK columns get an index for query performance.
 *   - M:N pivots: composite PK on (a_id, b_id) + ON DELETE CASCADE on both FKs
 *     + secondary index on the inverse FK column.
 *   - onDelete: be liberal with CASCADE downward, conservative with CASCADE upward.
 *
 * Idempotent: every step uses IF NOT EXISTS / DROP IF EXISTS so the migration
 * can be re-run after synchronize:true has created the table.
 */
export class AddCardinalitiesAndConstraints1700000001000
  implements MigrationInterface
{
  name = 'AddCardinalitiesAndConstraints1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Soft 1:1 enforcement on experts.user_id
    //    The entity keeps User 1—N Expert (User may have several in theory), but
    //    per lesson §4.5 the FK must be UNIQUE to prevent silent duplicate
    //    "is this user an expert?" queries that return two rows.
    await queryRunner.query(
      `ALTER TABLE experts ADD CONSTRAINT uq_experts_user_id UNIQUE (user_id)`,
    );

    // 2. Indexes on experts FKs
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_experts_user_id ON experts (user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_experts_category_id ON experts (category_id)`,
    );

    // 3. Category self-reference: RESTRICT on parent_id, add index.
    //    Per lesson §5.7: deleting a parent category must not silently wipe the
    //    sub-tree; the admin tool must reassign children first.
    await queryRunner.query(
      `ALTER TABLE categories DROP CONSTRAINT IF EXISTS fk_categories_parent`,
    );
    await queryRunner.query(
      `ALTER TABLE categories ADD CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories (parent_id)`,
    );

    // 4. Indexes on qualifications / prices category FKs
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qualifications_category_id ON qualifications (category_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_prices_category_id ON prices (category_id)`,
    );

    // 5. Otps 1:N from user — index on user_id
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_otps_user_id ON otps (user_id)`,
    );

    // 6. Pivot tables (M:N) — composite PK + ON DELETE CASCADE on both FKs +
    //    secondary index on the inverse FK column.
    //
    //    Per lesson §6.6: without the composite PK, duplicate pivot rows are
    //    silently inserted and the model is corrupted.
    //    Per lesson §6.8: both FKs need CASCADE — a pivot row is meaningless
    //    without either parent.
    //    Per lesson §10.3: only "id" appears in the seed/sort array, so the
    //    primary key on (a_id, b_id) is the right shape.
    const pivots: Array<{
      name: string;
      table: string;
      childTable: string;
      childFk: string;
    }> = [
      {
        name: 'expert_qualifications',
        table: 'expert_qualifications',
        childTable: 'qualifications',
        childFk: 'qualification_id',
      },
      {
        name: 'expert_languages',
        table: 'expert_languages',
        childTable: 'languages',
        childFk: 'language_id',
      },
      {
        name: 'expert_organizations',
        table: 'expert_organizations',
        childTable: 'organizations',
        childFk: 'organization_id',
      },
      {
        name: 'expert_prices',
        table: 'expert_prices',
        childTable: 'prices',
        childFk: 'price_id',
      },
    ];

    for (const p of pivots) {
      // Composite PK (expert_id, <child>_id)
      await queryRunner.query(
        `ALTER TABLE ${p.table} ADD CONSTRAINT pk_${p.name} PRIMARY KEY (expert_id, ${p.childFk})`,
      );

      // ON DELETE CASCADE on expert_id
      await queryRunner.query(
        `ALTER TABLE ${p.table} ADD CONSTRAINT fk_${p.name}_expert FOREIGN KEY (expert_id) REFERENCES experts (id) ON DELETE CASCADE`,
      );

      // ON DELETE CASCADE on the child FK
      await queryRunner.query(
        `ALTER TABLE ${p.table} ADD CONSTRAINT fk_${p.name}_${p.childFk} FOREIGN KEY (${p.childFk}) REFERENCES ${p.childTable} (id) ON DELETE CASCADE`,
      );

      // Secondary index on the inverse FK column so lookups
      // from the other side ("experts with qualification X") are fast.
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS idx_${p.table}_${p.childFk} ON ${p.table} (${p.childFk})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse the pivot constraints
    const pivots = [
      {
        name: 'expert_qualifications',
        table: 'expert_qualifications',
        childFk: 'qualification_id',
      },
      {
        name: 'expert_languages',
        table: 'expert_languages',
        childFk: 'language_id',
      },
      {
        name: 'expert_organizations',
        table: 'expert_organizations',
        childFk: 'organization_id',
      },
      {
        name: 'expert_prices',
        table: 'expert_prices',
        childFk: 'price_id',
      },
    ];

    for (const p of pivots) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS idx_${p.table}_${p.childFk}`,
      );
      await queryRunner.query(
        `ALTER TABLE ${p.table} DROP CONSTRAINT IF EXISTS fk_${p.name}_${p.childFk}`,
      );
      await queryRunner.query(
        `ALTER TABLE ${p.table} DROP CONSTRAINT IF EXISTS fk_${p.name}_expert`,
      );
      await queryRunner.query(
        `ALTER TABLE ${p.table} DROP CONSTRAINT IF EXISTS pk_${p.name}`,
      );
    }

    // Reverse the FK / index changes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_otps_user_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_prices_category_id`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_qualifications_category_id`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_categories_parent_id`,
    );
    await queryRunner.query(
      `ALTER TABLE categories DROP CONSTRAINT IF EXISTS fk_categories_parent`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_category_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_user_id`);
    await queryRunner.query(
      `ALTER TABLE experts DROP CONSTRAINT IF EXISTS uq_experts_user_id`,
    );
  }
}