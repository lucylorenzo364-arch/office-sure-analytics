export declare function buildObjectFromEntries<T extends [key: string, value: any]>(entries: T[]): {
    [key in T[0]]: T[1];
};
