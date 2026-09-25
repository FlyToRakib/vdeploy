import { describe, expect, it } from 'vitest';
import { dumpRefusal, majorOf, sniffDump } from './dumps.js';

const postgres18 = { engine: 'postgres', version: '18' };

describe('what a dump from somewhere else actually is', () => {
  it('knows a custom-format pg_dump by its first bytes, not its name', () => {
    expect(sniffDump(Buffer.from('PGDMP\u0001\u000e\u0000', 'latin1'))).toEqual({
      format: 'postgres-custom',
      engine: 'postgres',
      version: null,
    });
  });

  it('reads the version out of a plain dump, from either family', () => {
    const pg =
      '--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version 16.2\nSET x;';
    expect(sniffDump(Buffer.from(pg))).toEqual({
      format: 'sql',
      engine: 'postgres',
      version: '16.2',
    });
    const my = '-- MySQL dump 10.13  Distrib 8.0.36\n-- Server version\t8.0.36\nCREATE TABLE t;';
    expect(sniffDump(Buffer.from(my))).toMatchObject({ engine: 'mysql', version: '8.0.36' });
    const maria = '-- MariaDB dump 10.19\n-- Server version\t11.8.2-MariaDB\nCREATE TABLE t;';
    expect(sniffDump(Buffer.from(maria))).toMatchObject({ engine: 'mariadb', version: '11.8.2' });
  });

  it('takes SQL that says nothing about itself for what it is', () => {
    expect(sniffDump(Buffer.from('CREATE TABLE posts (id int);'))).toEqual({
      format: 'sql',
      engine: null,
      version: null,
    });
  });

  it('is not fooled by a file that is not a dump at all', () => {
    expect(sniffDump(Buffer.from([0x1f, 0x8b, 0x08, 0x00])).format).toBeNull();
    expect(sniffDump(Buffer.from('PK\u0003\u0004', 'latin1')).format).toBeNull();
  });
});

describe('whether a dump can be loaded here', () => {
  it('lets an older dump into a newer database, but not the reverse', () => {
    const older = sniffDump(Buffer.from('-- Dumped from database version 16.2\nSET x;'));
    expect(dumpRefusal(older, postgres18)).toBeNull();
    const newer = sniffDump(Buffer.from('-- Dumped from database version 19.0\nSET x;'));
    expect(dumpRefusal(newer, postgres18)).toContain('cannot read a newer');
    expect(dumpRefusal(newer, postgres18)).toContain('make a 19 database');
  });

  it('says so when the dump is from another engine entirely', () => {
    const mysql = sniffDump(Buffer.from('-- Server version\t8.0.36\nCREATE TABLE t;'));
    expect(dumpRefusal(mysql, postgres18)).toContain('came from mysql');
    // MySQL and MariaDB read each other's dumps; that is not refused.
    const maria = sniffDump(Buffer.from('-- Server version\t11.8.2-MariaDB\nCREATE TABLE t;'));
    expect(dumpRefusal(maria, { engine: 'mysql', version: '8.4' })).toBeNull();
  });

  it('refuses what cannot be sent to a running server at all', () => {
    const rdb = sniffDump(Buffer.from('REDIS0011', 'latin1'));
    expect(dumpRefusal(rdb, { engine: 'redis', version: '8' })).toContain('when it starts');
    expect(dumpRefusal(sniffDump(Buffer.from([0x1f, 0x8b])), postgres18)).toContain(
      'not a database dump',
    );
  });

  it('cannot read the version of a custom-format dump, and does not pretend to', () => {
    const custom = sniffDump(Buffer.from('PGDMP\u0001\u000e', 'latin1'));
    expect(custom.version).toBeNull();
    expect(dumpRefusal(custom, { engine: 'postgres', version: '15' })).toBeNull();
    expect(dumpRefusal(custom, { engine: 'mysql', version: '8.4' })).toContain('cannot read it');
  });

  it('compares major versions, which is what decides it', () => {
    expect(majorOf('16.2')).toBe(16);
    expect(majorOf('8')).toBe(8);
  });
});
