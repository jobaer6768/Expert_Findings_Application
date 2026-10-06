import * as fs from 'fs';
import * as path from 'path';

/**
 * Cardinalities smoke test — Lesson 02.
 *
 * These tests assert the entity source files contain the right decorator
 * patterns. We use source-level checks (regex) instead of decorator metadata
 * because ts-jest in this project does not run the TypeORM decorators at
 * test time (the project uses `isolatedModules: true` which skips the
 * decorator pass). The build (npm run build) does run them, so the entity
 * is verified at build time; this test acts as a static guard to catch
 * regressions before code review.
 *
 * Each test corresponds to a rule in Lesson 02 and quotes the section.
 */

const SRC_ROOT = path.resolve(__dirname, '..');

const readEntity = (rel: string): string =>
  fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');

const migrationsDir = path.resolve(SRC_ROOT, '..', 'migrations');
const readMigration = (file: string): string =>
  fs.readFileSync(path.join(migrationsDir, file), 'utf8');

const expert = () => readEntity('experts/entities/expert.entity.ts');
const user = () => readEntity('user/entities/user.entity.ts');
const category = () => readEntity('categories/entities/category.entity.ts');
const otp = () => readEntity('otp/entities/otp.entity.ts');
const qualification = () =>
  readEntity('qualifications/entities/qualification.entity.ts');
const price = () => readEntity('prices/entities/price.entity.ts');
const migration = () =>
  readMigration('1700000001000-AddCardinalitiesAndConstraints.ts');

describe('Cardinalities — Lesson 02', () => {
  // ─────────────────────────────────────────────────────────────────────
  // 1:N — User 1—N Expert (soft-1:1 enforced via UNIQUE migration)
  // ─────────────────────────────────────────────────────────────────────
  describe('User 1—N Expert (soft-1:1)', () => {
    it('Expert has @ManyToOne User with @JoinColumn(user_id)', () => {
      const src = expert();
      expect(src).toMatch(
        /@ManyToOne\(\(\)\s*=>\s*User[\s\S]*?onDelete:\s*'CASCADE'[\s\S]*?\)\s*@JoinColumn\(\{\s*name:\s*'user_id'\s*\}\)/,
      );
    });

    it('User declares the inverse as @OneToMany', () => {
      const src = user();
      expect(src).toMatch(/@OneToMany\(\(\)\s*=>\s*Expert/);
    });

    it('User.experts does NOT have @JoinColumn (inverse side rule §4.2)', () => {
      const src = user();
      // Find the @OneToMany(() => Expert block and assert no @JoinColumn inside.
      const match = src.match(
        /@OneToMany\(\(\)\s*=>\s*Expert[\s\S]*?experts\s*:\s*Expert\[\]/,
      );
      expect(match).toBeTruthy();
      expect(match![0]).not.toMatch(/@JoinColumn/);
    });

    it('Migration adds UNIQUE (user_id) on experts (lesson §4.5)', () => {
      const src = migration();
      expect(src).toMatch(
        /ALTER TABLE experts ADD CONSTRAINT uq_experts_user_id UNIQUE\s*\(\s*user_id\s*\)/i,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1:N — Category self-reference (parent / children)
  // ─────────────────────────────────────────────────────────────────────
  describe('Category self-reference (1:N)', () => {
    it('Category.children is @OneToMany (no @JoinColumn)', () => {
      const src = category();
      const m = src.match(
        /@OneToMany\(\(\)\s*=>\s*Category[\s\S]*?children\s*!:\s*Category\[\]/,
      );
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinColumn/);
    });

    it('Category.parent is @ManyToOne + @JoinColumn(parent_id)', () => {
      const src = category();
      expect(src).toMatch(
        /@ManyToOne\(\(\)\s*=>\s*Category[\s\S]*?onDelete:\s*'RESTRICT'[\s\S]*?\)\s*@JoinColumn\(\{\s*name:\s*'parent_id'\s*\}\)/,
      );
    });

    it('No duplicate @Column parent_id (would create two columns — lesson §4)', () => {
      const src = category();
      // There must be no standalone @Column(...parent_id...) outside of @JoinColumn.
      // Specifically, we forbid a line like `@Column(...parent_id...)`.
      expect(src).not.toMatch(/@Column\([^)]*parent_id[^)]*\)/);
    });

    it('onDelete is RESTRICT (lesson §5.7: don\'t silently wipe sub-tree)', () => {
      const src = category();
      // The parent @ManyToOne must have onDelete: 'RESTRICT'.
      const m = src.match(
        /@ManyToOne\(\(\)\s*=>\s*Category[\s\S]*?\}\)/,
      );
      expect(m).toBeTruthy();
      expect(m![0]).toMatch(/onDelete:\s*'RESTRICT'/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1:N — Category 1—N Qualification / Price / Expert
  // ─────────────────────────────────────────────────────────────────────
  describe('Category 1—N Qualification / Price / Expert', () => {
    it('Qualification.category is @ManyToOne + @JoinColumn (RESTRICT)', () => {
      const src = qualification();
      expect(src).toMatch(
        /@ManyToOne\(\(\)\s*=>\s*Category[\s\S]*?onDelete:\s*'RESTRICT'[\s\S]*?\)\s*@JoinColumn\(\{\s*name:\s*'category_id'\s*\}\)/,
      );
    });

    it('Price.category is @ManyToOne + @JoinColumn (RESTRICT)', () => {
      const src = price();
      expect(src).toMatch(
        /@ManyToOne\(\(\)\s*=>\s*Category[\s\S]*?onDelete:\s*'RESTRICT'[\s\S]*?\)\s*@JoinColumn\(\{\s*name:\s*'category_id'\s*\}\)/,
      );
    });

    it('Category.qualifications is @OneToMany (no @JoinColumn)', () => {
      const src = category();
      const m = src.match(
        /@OneToMany\(\(\)\s*=>\s*Qualification[\s\S]*?qualifications\s*!:/,
      );
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinColumn/);
    });

    it('Category.prices is @OneToMany (no @JoinColumn)', () => {
      const src = category();
      const m = src.match(
        /@OneToMany\(\(\)\s*=>\s*Price[\s\S]*?prices\s*!:/,
      );
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinColumn/);
    });

    it('Category.experts is @OneToMany (no @JoinColumn)', () => {
      const src = category();
      const m = src.match(/@OneToMany\(\(\)\s*=>\s*Expert[\s\S]*?experts\s*!:/);
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinColumn/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // M:N — Expert ↔ Qualification / Language / Organization / Price
  // ─────────────────────────────────────────────────────────────────────
  describe('Expert M:N pivots', () => {
    it('Expert.qualifications is @ManyToMany + @JoinTable(expert_qualifications)', () => {
      const src = expert();
      expect(src).toMatch(
        /@ManyToMany\(\(\)\s*=>\s*Qualification[\s\S]*?@JoinTable\(\{\s*name:\s*'expert_qualifications'/,
      );
    });

    it('Qualification.experts is @ManyToMany (no @JoinTable — inverse rule §6.3)', () => {
      const src = qualification();
      expect(src).toMatch(/@ManyToMany\(\(\)\s*=>\s*Expert/);
      const m = src.match(/@ManyToMany\(\(\)\s*=>\s*Expert[\s\S]*?experts/);
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinTable/);
    });

    it('Expert.languages has @JoinTable on Expert side', () => {
      const src = expert();
      expect(src).toMatch(
        /@ManyToMany\(\(\)\s*=>\s*Language[\s\S]*?@JoinTable\(\{\s*name:\s*'expert_languages'/,
      );
    });

    it('Expert.organizations has @JoinTable on Expert side', () => {
      const src = expert();
      expect(src).toMatch(
        /@ManyToMany\(\(\)\s*=>\s*Organization[\s\S]*?@JoinTable\(\{\s*name:\s*'expert_organizations'/,
      );
    });

    it('Expert.prices has @JoinTable on Expert side', () => {
      const src = expert();
      expect(src).toMatch(
        /@ManyToMany\(\(\)\s*=>\s*Price[\s\S]*?@JoinTable\(\{\s*name:\s*'expert_prices'/,
      );
    });

    it('Migration adds composite PKs to all four pivots (lesson §6.6)', () => {
      const src = migration();
      // The migration uses a template literal `pk_${p.name}` and `PRIMARY KEY (expert_id, ${p.childFk})`.
      // We assert on the structural patterns, not the rendered strings.
      expect(src).toMatch(/ADD CONSTRAINT pk_\$\{p\.name\} PRIMARY KEY/);
      expect(src).toMatch(/PRIMARY KEY \(expert_id, \$\{p\.childFk\}\)/);
      // The pivots array is iterated; check that all four pivot names are listed.
      for (const pivot of [
        'expert_qualifications',
        'expert_languages',
        'expert_organizations',
        'expert_prices',
      ]) {
        expect(src).toContain(pivot);
      }
    });

    it('Migration adds ON DELETE CASCADE on both FKs of each pivot (lesson §6.8)', () => {
      const src = migration();
      // Source-level check: the migration's up() contains an `ON DELETE CASCADE`
      // clause for both the expert_id FK and the <child>_id FK, inside a loop
      // that iterates all four pivots.
      // At runtime this evaluates to 4 pivots × 2 CASCADEs = 8.
      expect(src).toMatch(/ON DELETE CASCADE/g);
      // The two CASCADE-bearing template literals are inside the loop body.
      expect(src).toMatch(/fk_\$\{p\.name\}_expert FOREIGN KEY[\s\S]*?ON DELETE CASCADE/);
      expect(src).toMatch(
        /fk_\$\{p\.name\}_\$\{p\.childFk\} FOREIGN KEY[\s\S]*?ON DELETE CASCADE/,
      );
    });

    it('Migration adds secondary index on inverse FK column of each pivot', () => {
      const src = migration();
      // The migration uses `idx_${p.table}_${p.childFk}`.
      expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_\$\{p\.table\}_\$\{p\.childFk\}/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1:N — User 1—N Otp (changed from 1:1 in the lesson)
  // ─────────────────────────────────────────────────────────────────────
  describe('User 1—N Otp (lesson §4.5 + Lesson 00 note)', () => {
    it('Otp.user is @ManyToOne + @JoinColumn(user_id) — owning side', () => {
      const src = otp();
      expect(src).toMatch(
        /@ManyToOne\(\(\)\s*=>\s*User[\s\S]*?onDelete:\s*'CASCADE'[\s\S]*?\)\s*@JoinColumn\(\{\s*name:\s*'user_id'\s*\}\)/,
      );
    });

    it('Otp.user @JoinColumn is NOT unique (1:N, not 1:1)', () => {
      const src = otp();
      const m = src.match(/@JoinColumn\(\{\s*name:\s*'user_id'\s*[^}]*\}\)/);
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/unique:\s*true/);
    });

    it('User declares inverse @OneToMany(() => Otp)', () => {
      const src = user();
      expect(src).toMatch(/@OneToMany\(\(\)\s*=>\s*Otp/);
    });

    it('User.otps has no @JoinColumn (inverse rule)', () => {
      const src = user();
      const m = src.match(
        /@OneToMany\(\(\)\s*=>\s*Otp[\s\S]*?otps\s*:\s*Otp\[\]/,
      );
      expect(m).toBeTruthy();
      expect(m![0]).not.toMatch(/@JoinColumn/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Indexes — every FK gets an index
  // ─────────────────────────────────────────────────────────────────────
  describe('Index decorators', () => {
    it('Expert has @Index on user_id and category_id', () => {
      const src = expert();
      expect(src).toContain("'idx_experts_user_id'");
      expect(src).toContain("'idx_experts_category_id'");
    });

    it('Category has @Index on parent_id', () => {
      const src = category();
      expect(src).toContain("'idx_categories_parent_id'");
    });
  });
});