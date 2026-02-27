export function readDenseTableFromUrl(param = 'dense'): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get(param) === '1';
}

export function setDenseTableQueryParam(params: URLSearchParams, dense: boolean, param = 'dense') {
  if (dense) {
    params.set(param, '1');
    return;
  }

  params.delete(param);
}
