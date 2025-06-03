export {}

declare global {
    interface Window {
        docData?: any
        docDataMap?: Record<string, any>
    }
}
