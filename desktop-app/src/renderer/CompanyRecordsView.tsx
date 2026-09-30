import React from 'react';
import { groupRecordsByCompany } from './recordsView.ts';
import { RecordsTable, type RecordsTableProps } from './RecordsTable.tsx';

type CompanyRecordsViewProps = RecordsTableProps;

export function CompanyRecordsView({ records, onDeleteCompany, ...tableProps }: CompanyRecordsViewProps) {
  if (records.length === 0) return <RecordsTable records={records} {...tableProps} />;
  const groups = groupRecordsByCompany(records);
  return (
    <div className="company-record-groups">
      <div className="company-group-summary">
        <strong>{groups.length} 家公司</strong>
        <span>{records.length} 个岗位；投递岗位多的公司优先显示</span>
      </div>
      {groups.map(group => (
        <section className="company-record-group" key={group.key}>
          <header>
            <div>
              <h2>{group.companyName}</h2>
              <p>{group.records.map(record => record.jobTitle || '未填写岗位').join(' · ')}</p>
            </div>
            <strong>{group.records.length} 个岗位</strong>
            {onDeleteCompany && <button type="button" className="button-danger"
              disabled={tableProps.busy || Boolean(tableProps.savingRecordId) || Boolean(tableProps.savingFavoriteRecordId)}
              aria-label={`删除公司 ${group.companyName}`}
              onClick={() => onDeleteCompany(group.key)}>删除公司</button>}
          </header>
          <RecordsTable records={group.records} {...tableProps} />
        </section>
      ))}
    </div>
  );
}
