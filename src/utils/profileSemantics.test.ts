import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEducationCountryRegion, resolvePersonalNationality } from './profileSemantics.ts';

test('身份证可在国籍未填时安全推导中国', () => {
  assert.equal(resolvePersonalNationality({
    name: '', gender: '', birthDate: '', phone: '', email: '',
    idType: '身份证', idCard: '110101200001010011',
  }), '中国');
  assert.equal(resolvePersonalNationality({
    name: '', gender: '', birthDate: '', phone: '', email: '', idType: '护照',
  }), '');
});

test('教育国家仅对明确的中国教育类型回退', () => {
  const base = { id: 'e1', school: '', major: '', degree: '', startDate: '', endDate: '' };
  assert.equal(resolveEducationCountryRegion({ ...base, educationType: '统招全日制' }), '中国');
  assert.equal(resolveEducationCountryRegion({ ...base, educationType: '海外及港澳台' }), '');
  assert.equal(resolveEducationCountryRegion({ ...base, educationType: '', countryRegion: '新加坡' }), '新加坡');
  assert.equal(resolveEducationCountryRegion(base), '');
});
