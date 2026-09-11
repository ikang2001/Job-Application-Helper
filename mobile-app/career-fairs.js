export function filterAndSortCareerFairs(fairs, query = '') {
  const keyword = query.trim().toLocaleLowerCase();
  return [...fairs]
    .filter(fair => !keyword || searchValues(fair).some(value => (
      String(value ?? '').toLocaleLowerCase().includes(keyword)
    )))
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
}

function searchValues(fair) {
  return [
    fair.name,
    fair.location,
    fair.organizer,
    fair.targetCompanies,
    fair.targetRoles,
    fair.notes,
  ];
}
