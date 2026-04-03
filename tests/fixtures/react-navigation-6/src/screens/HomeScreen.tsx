import React from 'react';
import { View, Button } from 'react-native';
import { NativeModules } from 'react-native';

const { CameraModule } = NativeModules;

export function HomeScreen({ navigation }: any) {
  return (
    <View>
      <Button title="Profile" onPress={() => navigation.navigate('Profile', { userId: 1 })} />
      <Button title="Settings" onPress={() => navigation.navigate('Settings')} />
    </View>
  );
}
