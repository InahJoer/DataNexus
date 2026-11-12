/** Tipos mínimos de unzipper (lectura de un ZIP por su índice), que no publica sus propios tipos. */
declare module 'unzipper' {
  namespace unzipper {
    interface File {
      path: string;
      type: 'File' | 'Directory';
      compressedSize: number;
      uncompressedSize: number;
      stream(password?: string): NodeJS.ReadableStream;
    }
    interface CentralDirectory {
      files: File[];
    }
  }
  const unzipper: {
    Open: {
      file(path: string): Promise<unzipper.CentralDirectory>;
    };
  };
  export default unzipper;
}
