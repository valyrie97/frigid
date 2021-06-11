// import { Ubjson } from '@shelacek/ubjson';
import { existsSync, readFileSync, writeFileSync } from 'fs';

export default class Serializable {

	constructor(...args: any[]) {}

	// things that need to be stored only in cold
	// storage are keyed with a special prefix
	// its namesapce pollution, eventually the
	// format should be a bit more complex, to
	// avoid this but... simplicity for now...
	static CLASS_REFERENCE = '$$CLASS_NAME';
	static INSTANCE_DECLARATION = '$$INSTANCE_ID';
	static INSTANCE_REFERENCE = '$$INSTANCE_REF';

	// things that need to be stored only at runtime
	// are keyed with symbols to not interfere with
	// user code.
	static PERSIST_LOCATION = Symbol('PERSIST_LOCATION');

	toJson() {
		return JSON.stringify(this.toSerializableObject(), null, 2);
	}

	static serializationDependencies(): any[] {
		return [];
	}

	static fromJson(str: string) {
		return this.fromSerializableObject(JSON.parse(str));
	}

	// thisdoesnt operate recursively, it doesnt need to, because dependency
	// resoltion isnt required. we simply declare the dependencies.
	// so we never touch static serializationDependencies!
	toSerializableObject() {
		const instances: Map<number, object> = new Map();

		const transformValue = (val: any): any => {
			if(Array.isArray(val)) {
				return transformArray(val);
			} else if (val === null || val === undefined) {
				return val;
			} else if(typeof val === 'object') {
				return transformObject(val);
			} else {
				return val;
			}
		}

		const transformObject = (obj: any): any => {

			// is this a circular reference, or reference to a previously
			// known object...
			const duplicateObjectLink = reverseLookup(instances, obj);
			if(duplicateObjectLink !== null) return { [Serializable.INSTANCE_REFERENCE]: duplicateObjectLink };
			
			const clone: any = {};
			const newId = instances.size;
			clone[Serializable.INSTANCE_DECLARATION] = newId;
			instances.set(newId, obj);

			for(const prop of Object.keys(obj)) {
				if(prop.startsWith('_')) continue;
				else clone[prop] = transformValue(obj[prop]);
			}

			if(obj instanceof Serializable) clone[Serializable.CLASS_REFERENCE] = obj.constructor.name;
			
			// console.log('recorded instance', newId, obj, instances);

			return clone;
		}

		const transformArray = (arr: any[]): any[] => {
			const clone = [];
			for(const item of arr) {
				clone.push(transformValue(item));
			}
			return clone;
		}
		
		return transformObject(this);
	}

	static fromSerializableObject(obj: any, instances: Map<number, object> = new Map()) {
		// console.log('deserializing', obj);
		if(obj[Serializable.CLASS_REFERENCE] !== this.name) return null;

		const transformValue = (val: any): any => {
			if(Array.isArray(val)) {
				return transformArray(val);
			} else if(val === null || val === undefined) {
				return val;
			} else if(typeof val === 'object') {
				if(Serializable.CLASS_REFERENCE in val) {
					const classes = this.serializationDependencies();
					const matchingClasses = classes.filter((classObject) => {
						return classObject.name === val[Serializable.CLASS_REFERENCE]
					});
					if(matchingClasses.length === 1) {
						return matchingClasses[0].fromSerializableObject(val, instances);
					} else {
						throw new Error('Unknown class ' + val[Serializable.CLASS_REFERENCE] + '!\n' + 
							'Did you forget to add ' + val[Serializable.CLASS_REFERENCE] + ' to static serializationDependencies?');
					}
				}
				return transformObject(val);
			} else {
				return val;
			}
		}

		const transformObject = (obj: any): any => {
			let constructedObject = null;

			const clone: any = {};
			for(const prop of Object.keys(obj)) {
				if(prop.startsWith('_')) continue;
				// if(prop.startsWith('$$')) continue;

				clone[prop] = transformValue(obj[prop]);
			}
			constructedObject = clone;

			if(Serializable.INSTANCE_DECLARATION in obj) {
				// console.log('recording instance', obj[Serializable.INSTANCE_DECLARATION], constructedObject);
				instances.set(obj[Serializable.INSTANCE_DECLARATION], constructedObject);
			}

			return constructedObject;
		}

		const transformArray = (arr: any[]): any[] => {
			const clone = [];
			for(const item of arr) {
				clone.push(transformValue(item));
			}
			return clone;
		}

		const clone = transformObject(obj);
		if(Serializable.CLASS_REFERENCE in obj)
			clone.__proto__ = this.prototype;

		const secondPass = (obj) => {
			for(const key of Object.keys(obj)) {
				if(key === Serializable.INSTANCE_DECLARATION) delete obj[key];
				if(key === Serializable.CLASS_REFERENCE) delete obj[key];
				const val = obj[key];
				if(typeof val === 'object') {
					if(Serializable.INSTANCE_REFERENCE in val) {
						const refId = val[Serializable.INSTANCE_REFERENCE];
						if(instances.has(refId)) {
							obj[key] = instances.get(refId);
						}
					}
					else obj[key] = secondPass(val);
				}
			}
			return obj;
		}

		const parse = secondPass(clone);

		// clone.restore?.();

		return parse;
	}

	serialize({
		encoding = 'json'
	} = {}) {

		switch(encoding) {
			case 'json': return this.toJson();
			case 'ubjson':
			// case 'ubj': return this.toUbj();
			default: {
				throw new TypeError('Unknown encoding: ' + encoding);
			}
		}

	}
	
	static deserialize(obj: any, {
		encoding = 'json'
	} = {}) {

		switch(encoding) {
			case 'json': return this.fromJson(obj);
			case 'ubjson':
			// case 'ubj': return this.fromUbj(obj);
			default: {
				throw new TypeError('Unknown encoding: ' + encoding);
			}
		}
	}

	async restore() {}

	static createFromDisk(filename: string, ...args: any[]) {
		const filepath = createFilepath(filename);
		if(existsSync(filepath)) {
			const instance = this.deserialize(readFileSync(filepath));
			// TS is plain and simply wrong... symbols can be used to index object...
			// @ts-ignore
			instance[Serializable.PERSIST_LOCATION] = filepath;
			instance?.restore();
			return instance;
		} else {
			const instance = new this(...args);
			// again... TS is wrong...
			// @ts-ignore
			instance[Serializable.PERSIST_LOCATION] = filepath;
			instance?.updateDisk();
			return instance;
		}
	}

	updateDisk(filepath?: string) {
		// if it hasnt yet been written to disk...
		// this can happen if the contrustor 
		// was called outside of createFromDisk
		if(filepath) {
			// see above... TS7053 is just _wrong_. incorrect. thats not how JS works.
			// @ts-ignore
			this[Serializable.PERSIST_LOCATION] = createFilepath(filepath);
		}
		const data = this.serialize();
		// this is getting annoying...
		// @ts-ignore
		writeFileSync(this[Serializable.PERSIST_LOCATION], data);
	}
}

function createFilepath(path: string) {
	return `data/${path}`;
}


function reverseLookup<K, V>(map: Map<K, V>, value: V): K {
	// console.log('searching for', value, 'in', map);
	for(const [k, v] of map) {
		if(v === value) {
			// console.log('found in key', k);
			return k;
		}
	}
	// console.log(value, 'not found')
	return null;
}