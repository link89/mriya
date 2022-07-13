import _ from "lodash";
import BlueBird from 'bluebird';

type IdType = number | string;

export class ResourceMapper<T> {

  private namespaces: Map<String, Map<IdType, T>> = new Map();

  constructor() { }

  private getIdMap(namespace: string) {
    if (!this.namespaces.has(namespace)) throw Error(`namespace ${namespace} doesn't exist`);
    return this.namespaces.get(namespace)!;
  }

  allocate(resource: T, namespace: string, ids: IdType[]) {
    if (!this.namespaces.has(namespace)) {
      this.namespaces.set(namespace, new Map());
    }
    const idMap = this.getIdMap(namespace);
    for (const id of ids) {
      if (idMap.has(id)) throw Error(`duplicated id ${id} in namespace: ${namespace}`);
      idMap.set(id, resource);
    }
  }

  mapAsync<V>(
    namespace: string, ids: IdType[],
    fn: (resource: T, groupIds: IdType[]) => Promise<V>,
    options?: BlueBird.ConcurrencyOption
  ) {
    const idMap = this.getIdMap(namespace);
    // group ids by resource
    const groups: Map<T, IdType[]> = new Map();
    for (const id of ids) {
      const res = idMap.get(id);
      if (!res) throw Error(`resource id ${id} doesn't exist in namespace ${namespace}`);

      if (!groups.has(res)) {
        groups.set(res, []);
      }
      const groupIds = groups.get(res)!;
      groupIds.push(id);
    }
    return BlueBird.map(groups.entries(), ([res, groupIds]) => fn(res, groupIds), options)
  }
}